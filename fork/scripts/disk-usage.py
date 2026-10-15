#!/usr/bin/python3
"""Fork (Owner): measure what directories really cost on an APFS disk.

APFS clones (cp -c, clonefile; pnpm imports node_modules this way) share data
blocks until one copy is written, so du counts every clone in full. This walks
every extent of every regular file with fcntl F_LOG2PHYS_EXT and works with the
physical block ranges instead.

  disk-usage.py TARGET... [--context DIR...] [--skip-git] [--min-size N] [--json]

Each file belongs to the most specific TARGET or --context root it is under, so
nested roots are measured once. Per root:

  logical      sum of file sizes (sparse holes included)
  allocated    sum of st_blocks*512, what du reports
  physical     size of the union of the physical blocks its files use
  reclaimable  physical blocks no file under any other scanned root uses: an
               estimate of what deleting the target frees. Exclusive only
               relative to what was scanned; unscanned clones elsewhere and
               APFS snapshots can still hold those blocks.

Files with no mappable extents (decmpfs-compressed files keep their data in a
resource fork; others fail with an error) are counted apart as "unmapped" and
are absent from physical and reclaimable. Hard links count once per root.
"""
import argparse
import fcntl
import heapq
import json
import os
import stat
import struct
import sys
import time
from array import array

F_LOG2PHYS_EXT = 65
L2P = struct.Struct("=Iqq")
LEN_BITS = 32
LEN_MASK = (1 << LEN_BITS) - 1
FLUSH_AT = 2_000_000
MAX_RUNS = 16
PROGRESS_EVERY = 200_000
GIB = 1 << 30


def merge_packed(keys):
    """Sorted (start << 32 | len) block keys to a flat array of disjoint [start, end) pairs."""
    out = array("q")
    cs = ce = -1
    for k in keys:
        s = k >> LEN_BITS
        e = s + (k & LEN_MASK)
        if s <= ce:
            if e > ce:
                ce = e
        else:
            if ce >= 0:
                out.append(cs)
                out.append(ce)
            cs, ce = s, e
    if ce >= 0:
        out.append(cs)
        out.append(ce)
    return out


def merge_runs(runs):
    """Union several flat disjoint-interval arrays into one."""
    if len(runs) == 1:
        return runs[0]
    pairs = [zip(it, it) for it in (iter(r) for r in runs)]
    out = array("q")
    cs = ce = -1
    for s, e in heapq.merge(*pairs):
        if s <= ce:
            if e > ce:
                ce = e
        else:
            if ce >= 0:
                out.append(cs)
                out.append(ce)
            cs, ce = s, e
    if ce >= 0:
        out.append(cs)
        out.append(ce)
    return out


class Root:
    def __init__(self, path, kind):
        self.path = path
        self.kind = kind
        self.files = self.dirs = self.errors = 0
        self.logical = self.allocated = 0
        self.unmapped_files = self.unmapped_bytes = self.unmapped_allocated = 0
        self.small_files = self.small_bytes = 0
        self.extents = 0
        self.runs = []
        self.buf = []
        self.intervals = None
        self.physical = self.reclaimable = 0

    def flush(self):
        if self.buf:
            self.runs.append(merge_packed(sorted(set(self.buf))))
            self.buf = []
        if len(self.runs) > MAX_RUNS:
            self.runs = [merge_runs(self.runs)]

    def finish(self):
        self.flush()
        self.intervals = merge_runs(self.runs) if self.runs else array("q")
        self.runs = []
        iv = self.intervals
        self.physical = sum(iv[1::2]) - sum(iv[0::2])


def scan(root, skip_dirs, args, bs, progress):
    buf = root.buf
    seen_links = set()
    stack = [root.path]
    min_size = args.min_size
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError as e:
            root.errors += 1
            progress.error(d, e)
            continue
        root.dirs += 1
        with it:
            for ent in it:
                try:
                    if ent.is_dir(follow_symlinks=False):
                        if (args.skip_git and ent.name == ".git") or ent.path in skip_dirs:
                            continue
                        stack.append(ent.path)
                        continue
                    if not ent.is_file(follow_symlinks=False):
                        continue
                    st = ent.stat(follow_symlinks=False)
                except OSError as e:
                    root.errors += 1
                    progress.error(ent.path, e)
                    continue
                if st.st_nlink > 1:
                    key = (st.st_dev, st.st_ino)
                    if key in seen_links:
                        continue
                    seen_links.add(key)
                size = st.st_size
                root.files += 1
                root.logical += size
                root.allocated += st.st_blocks * 512
                progress.tick()
                if size == 0:
                    continue
                if size < min_size:
                    root.small_files += 1
                    root.small_bytes += size
                    continue
                off = 0
                try:
                    fd = os.open(ent.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                except OSError as e:
                    fd = -1
                    root.errors += 1
                    progress.error(ent.path, e)
                if fd >= 0:
                    try:
                        while off < size:
                            try:
                                _, n, dev = L2P.unpack(fcntl.fcntl(fd, F_LOG2PHYS_EXT, L2P.pack(0, size - off, off)))
                            except OSError as e:
                                if off or e.errno != 45:  # ENOTSUP is the decmpfs case, not an error
                                    root.errors += 1
                                    progress.error(ent.path, e)
                                break
                            if n <= 0:
                                break
                            if dev >= 0:
                                s = dev // bs
                                e = (dev + n + bs - 1) // bs
                                while e > s:
                                    ln = min(e - s, LEN_MASK)
                                    buf.append(s << LEN_BITS | ln)
                                    s += ln
                                root.extents += 1
                            off += n
                    finally:
                        os.close(fd)
                if off < size:
                    root.unmapped_files += 1
                    root.unmapped_bytes += size - off
                    root.unmapped_allocated += st.st_blocks * 512
                if len(buf) >= FLUSH_AT:
                    root.flush()
                    buf = root.buf


class Progress:
    def __init__(self, quiet):
        self.quiet = quiet
        self.n = 0
        self.start = time.monotonic()
        self.root = ""
        self.samples = []

    def tick(self):
        self.n += 1
        if not self.quiet and self.n % PROGRESS_EVERY == 0:
            rate = self.n / max(time.monotonic() - self.start, 1e-9)
            print(f"  {self.n:,} files, {rate:,.0f}/s, in {self.root}", file=sys.stderr, flush=True)

    def error(self, path, e):
        if len(self.samples) < 10:
            self.samples.append(f"{path}: {e}")


def sweep(roots, target_mask):
    """Sweep all roots' disjoint intervals at once with the owner set as a bitmask."""
    def events(iv, i):
        return ((x << 6) | i for x in iv)

    streams = [events(r.intervals, i) for i, r in enumerate(roots)]
    union_all = union_targets = 0
    excl = [0] * len(roots)
    mask = prev = 0
    for ev in heapq.merge(*streams):
        pos = ev >> 6
        if mask:
            seg = pos - prev
            union_all += seg
            if mask & target_mask:
                union_targets += seg
            if not mask & (mask - 1):
                excl[mask.bit_length() - 1] += seg
        mask ^= 1 << (ev & 63)
        prev = pos
    for r, x in zip(roots, excl):
        r.reclaimable = x
    return union_targets, union_all


def gib(n):
    return f"{n / GIB:9.2f}"


def main():
    p = argparse.ArgumentParser(
        description="Measure logical, du-allocated, physical (clone-aware) and reclaimable bytes on APFS.",
        epilog="Reclaimable is exclusive only relative to the scanned roots; snapshots and unscanned clones can still hold blocks.",
    )
    p.add_argument("targets", nargs="+", metavar="TARGET", help="directories to measure")
    p.add_argument("--context", nargs="*", default=[], metavar="DIR", help="other directories whose blocks count as shared, not reclaimable")
    p.add_argument("--skip-git", action="store_true", help="skip .git directories")
    p.add_argument("--min-size", type=int, default=0, metavar="BYTES", help="do not map files smaller than this (counted in logical only)")
    p.add_argument("--json", action="store_true", help="print JSON (bytes) instead of a table")
    p.add_argument("--quiet", action="store_true", help="no progress on stderr")
    args = p.parse_args()

    roots = []
    seen = {}
    for kind, paths in (("target", args.targets), ("context", args.context)):
        for raw in paths:
            path = os.path.realpath(os.path.expanduser(raw))
            if not os.path.isdir(path):
                p.error(f"not a directory: {raw}")
            if path in seen:
                p.error(f"{raw} given twice (as {seen[path]} and {kind})")
            seen[path] = kind
            roots.append(Root(path, kind))
    if len(roots) > 63:
        p.error("at most 63 roots")
    if len({os.stat(r.path).st_dev for r in roots}) > 1:
        print("warning: roots span volumes; physical offsets are only comparable within one APFS container", file=sys.stderr)

    bs = os.statvfs(roots[0].path).f_frsize
    progress = Progress(args.quiet)
    all_paths = {r.path for r in roots}
    t0 = time.monotonic()
    for r in roots:
        progress.root = r.path
        skip = {q for q in all_paths if q != r.path and q.startswith(r.path + os.sep)}
        scan(r, skip, args, bs, progress)
        r.finish()
    t_scan = time.monotonic() - t0
    target_mask = sum(1 << i for i, r in enumerate(roots) if r.kind == "target")
    union_targets, union_all = sweep(roots, target_mask)
    elapsed = time.monotonic() - t0

    def row(r):
        return {
            "path": r.path,
            "kind": r.kind,
            "files": r.files,
            "dirs": r.dirs,
            "errors": r.errors,
            "extents": r.extents,
            "logical": r.logical,
            "allocated": r.allocated,
            "physical": r.physical * bs,
            "reclaimable": r.reclaimable * bs if r.kind == "target" else None,
            "unmapped_files": r.unmapped_files,
            "unmapped_bytes": r.unmapped_bytes,
            "unmapped_allocated": r.unmapped_allocated,
            "unmapped_min_size_files": r.small_files,
            "unmapped_min_size_bytes": r.small_bytes,
        }

    result = {
        "block_size": bs,
        "roots": [row(r) for r in roots],
        "targets_physical": union_targets * bs,
        "all_physical": union_all * bs,
        "error_samples": progress.samples,
        "scan_seconds": round(t_scan, 1),
        "seconds": round(elapsed, 1),
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return

    print(f"{'GiB':<8}{'logical':>10}{'du':>10}{'physical':>10}{'reclaim':>10}{'unmapped':>10}{'files':>12}{'dirs':>10}{'errors':>8}  path")
    for r in result["roots"]:
        rec = gib(r["reclaimable"]) if r["reclaimable"] is not None else f"{'-':>9}"
        print(
            f"{r['kind']:<8}{gib(r['logical'])} {gib(r['allocated'])} {gib(r['physical'])} {rec} {gib(r['unmapped_bytes'] + r['unmapped_min_size_bytes'])}"
            f"{r['files']:>12,}{r['dirs']:>10,}{r['errors']:>8,}  {r['path']}"
        )
    print(f"\nphysical of all targets together: {result['targets_physical'] / GIB:.2f} GiB")
    print(f"physical of everything scanned:   {result['all_physical'] / GIB:.2f} GiB")
    print("reclaimable = blocks no other scanned root uses; unscanned clones and APFS snapshots can still hold them.")
    print("unmapped = bytes of files with no mappable extents (compressed, errors, or under --min-size); not in physical.")
    if progress.samples:
        print("\nerrors (first few):")
        for s in progress.samples:
            print(f"  {s}")
    print(f"\n{elapsed:.1f}s ({t_scan:.1f}s scanning)")


if __name__ == "__main__":
    main()

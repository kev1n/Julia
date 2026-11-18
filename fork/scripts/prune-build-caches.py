#!/usr/bin/python3
"""Reclaim idle build output; never remove source or private files.

Dry run by default; the build Mac runs it hourly with --apply. Keep two
recent local builds warm; trim older installs after seven days, or after one
quiet hour when the volume holding them has less than 20 GiB available.
~/t3-fork and ~/.t3/worktrees may be symlinks onto another volume.
Managed worktrees keep their dependencies; generated output expires after one
quiet day, or one quiet hour under disk pressure.
"""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

DAY = 86400
CACHES = (
    ".vite-plus", "native/resource-monitor/target",
    "native/kde-snap-shot/target", "native/hyprland-snap-shot/target", "apps/server/dist",
    "apps/web/dist", "apps/desktop/dist", "apps/desktop/dist-electron",
    "apps/web/.vite-plus", "apps/server/.vite-plus", "apps/desktop/.vite-plus",
    "apps/mobile/android/build", "apps/mobile/android/app/build",
    "apps/mobile/android/.gradle", "apps/mobile/android/.cxx",
    "apps/mobile/android/app/.cxx",
)


def command(args, cwd=None):
    if args[0] == "git":
        args = ["git", "--no-optional-locks", *args[1:]]
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True,
                          timeout=30).stdout.decode("utf-8", errors="strict")


def is_inside(root, path):
    return path == root or root in path.parents


def protected_paths(home):
    """Read live ownership without ever opening T3's database read-write."""
    database = home / ".t3/userdata/statev2.sqlite"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2) as db:
        sessions = db.execute(
            "SELECT payload_json FROM orchestration_v2_projection_provider_sessions "
            "WHERE status != 'stopped'"
        ).fetchall()
        threads = db.execute("SELECT payload_json FROM orchestration_v2_projection_threads").fetchall()
        busy = {row[0] for row in db.execute(
            "SELECT thread_id FROM orchestration_v2_projection_runs "
            "WHERE status NOT IN ('completed','failed','cancelled','interrupted','rolled_back')"
        )}
        busy.update(row[0] for row in db.execute(
            "SELECT thread_id FROM orchestration_v2_effect_outbox "
            "WHERE status NOT IN ('succeeded','cancelled')"
        ))
        recent = {row[0] for row in db.execute(
            "SELECT thread_id FROM orchestration_v2_projection_runs "
            "WHERE requested_at > ? OR completed_at > ?",
            (datetime.datetime.fromtimestamp(time.time() - 3600, datetime.timezone.utc).isoformat(),) * 2,
        )}
    paths = {Path(json.loads(row[0])["cwd"]).resolve() for row in sessions}
    owners = {}
    for (payload,) in threads:
        thread = json.loads(payload)
        if thread.get("worktreePath"):
            root = Path(thread["worktreePath"]).resolve()
            owners[root] = owners.get(root, 0) + 1
            if thread["id"] in busy or thread["id"] in recent:
                paths.add(root)
    paths.update(root for root, count in owners.items() if count > 1)
    # Protect builds launched outside T3, too. Failure to inspect means no cleanup.
    output = command(["/usr/sbin/lsof", "-n", "-a", "-u", str(os.getuid()), "-d", "cwd", "-Fn"])
    paths.update(Path(line[1:]).resolve() for line in output.splitlines() if line.startswith("n/"))
    return paths


def mount_point(path):
    path = path.resolve()
    while not os.path.ismount(path):
        path = path.parent
    return path


def build_roots(home):
    # Follow a symlinked ~/t3-fork to its target; entries inside it must still be real.
    state = (home / "t3-fork").resolve()
    roots = []
    for parent, child in [(state / "local-builds", None), (state / "autofix", "worktree")]:
        if parent.is_symlink() or not parent.is_dir():
            continue
        for entry in parent.iterdir():
            root = entry / child if child else entry
            if entry.is_symlink() or root.is_symlink() or not root.is_dir():
                continue
            if root.resolve() != root.absolute():
                continue
            roots.append(root)
    return roots


def managed_worktree_roots(home):
    parent = (home / ".t3/worktrees").resolve()
    if not parent.is_dir():
        return []
    roots = []
    for project in parent.iterdir():
        if project.is_symlink() or not project.is_dir():
            continue
        for root in project.iterdir():
            if root.is_dir() and root.resolve() == root.absolute() and not root.is_symlink():
                roots.append(root)
    return roots


def activity_at(root):
    # Source copies may preserve timestamps. Checkout/index writes and the
    # build's generated directories still delay cleanup for at least an hour.
    paths = [root, root / ".git", root / ".git/index", root / ".git/HEAD"]
    paths += [root / name for name in CACHES + ("node_modules",)]
    # A worktree's .git is a pointer, not a directory. Use its real metadata so
    # a checkout/rebase refreshes the grace period without refreshing the index.
    paths += [Path(p) for p in command([
        "git", "rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "HEAD"
    ], root).splitlines()]
    latest = max(path.lstat().st_mtime for path in paths if path.exists())
    # Rebuilding an existing binary may not change the target directory's mtime.
    # Inspect generated output only, never dependency trees or symlink targets.
    for name in CACHES:
        cache = root / name
        if not cache.is_dir() or cache.is_symlink() or cache.resolve() != cache.absolute():
            continue
        for directory, dirs, files in os.walk(cache, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
            for entry in [Path(directory), *(Path(directory) / name for name in files)]:
                latest = max(latest, entry.lstat().st_mtime)
    return latest


def build_recency(root):
    # Removing caches changes directory mtimes. Do not mistake our own cleanup
    # for a new build and evict the copies we intentionally kept warm.
    metadata = [root / ".git/index", root / ".git/HEAD"]
    stamps = [path.stat().st_mtime for path in metadata if path.is_file()]
    return max(stamps) if stamps else root.stat().st_mtime


def disposable_paths(root, include_dependencies=True):
    if Path(command(["git", "rev-parse", "--show-toplevel"], root).strip()).resolve() != root:
        return []
    if command(["git", "status", "--porcelain=v1", "--untracked-files=normal"], root):
        return []
    candidates = set(CACHES)
    if include_dependencies:
        ignored = command(["git", "ls-files", "--others", "--ignored",
                           "--exclude-standard", "--directory", "-z"], root).split("\0")
        candidates.update(entry.rstrip("/") for entry in ignored
                          if entry.endswith("node_modules/") and
                          (entry == "node_modules/" or entry.endswith("/node_modules/")))
    result = []
    for name in sorted(candidates):
        target = root / name
        if (not is_inside(root, target) or target.is_symlink() or not target.is_dir()
                or target.resolve() != target.absolute()):
            continue
        tracked = command(["git", "ls-files", "--cached", "-z", "--", f":(literal){name}"], root)
        if tracked:
            continue
        ignored_check = subprocess.run(["git", "check-ignore", "--quiet", "--", name],
                                       cwd=root, timeout=30)
        if ignored_check.returncode != 0:
            continue
        if not any(is_inside(parent, target) for parent in result):
            result.append(target)
    return result


def eligible(root, protected, now, pressure, retained, days):
    if root in retained or any(is_inside(root, path) for path in protected):
        return False
    age = now - activity_at(root)
    return age >= DAY * days or (pressure and age >= 3600)


def sweep(home, apply=False, days=7, build_days=1):
    roots = build_roots(home)
    local = sorted((root for root in roots if root.parent.name == "local-builds"),
                   key=build_recency, reverse=True)
    retained = set(local[:2])
    scopes = [(root, True, days) for root in roots]
    scopes += [(root, False, build_days) for root in managed_worktree_roots(home)]
    seen = set()  # two symlinks onto one folder must not sweep it twice
    scopes = [scope for scope in scopes if not (scope[0] in seen or seen.add(scope[0]))]
    # Measure each volume that holds a root, not the home volume.
    mounts = {root: mount_point(root) for root, _, _ in scopes}
    volumes = {str(mount): {"freeBeforeBytes": shutil.disk_usage(mount).free}
               for mount in set(mounts.values())}
    for volume in volumes.values():
        volume["pressure"] = volume["freeBeforeBytes"] < 20 * 1024 ** 3
    protected = protected_paths(home)
    result = {"apply": apply, "volumes": volumes, "trimmed": [], "skipped": 0, "errors": 0}
    for root, include_dependencies, expiry in scopes:
        pressure = volumes[str(mounts[root])]["pressure"]
        try:
            if not eligible(root, protected, time.time(), pressure, retained, expiry):
                result["skipped"] += 1
                continue
            targets = disposable_paths(root, include_dependencies)
            if apply and targets:
                # Recheck ownership after Git scans; never act on an old inventory.
                protected = protected_paths(home)
                if not eligible(root, protected, time.time(), pressure, retained, expiry):
                    result["skipped"] += 1
                    continue
            for target in targets:
                if target.resolve() != target.absolute() or target.is_symlink():
                    continue
                if apply:
                    shutil.rmtree(target)
                result["trimmed"].append(str(target))
        except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
            # Do not print command output or private file contents into logs.
            result["errors"] += 1
    for mount, volume in volumes.items():
        volume["freeAfterBytes"] = shutil.disk_usage(mount).free
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--build-days", type=int, default=1)
    args = parser.parse_args()
    if args.days < 1 or args.build_days < 1:
        parser.error("--days and --build-days must be positive")
    home = Path.home().resolve()
    logs = home / "t3-fork/logs"
    logs.mkdir(parents=True, exist_ok=True)
    lock_path = logs / "cleanup.lock"
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            print(json.dumps(sweep(home, args.apply, args.days, args.build_days)), flush=True)
        except (OSError, sqlite3.Error, subprocess.SubprocessError, ValueError, KeyError):
            print(json.dumps({"skipped": "ownership inventory unavailable"}), flush=True)
            raise SystemExit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/python3
"""Fork (Owner): build-mac's artifacts server (com.example.t3code-fork.artifacts).

Serves ~/t3-fork/out to the tailnet (behind Tailscale Serve :8444) as static
files, plus /mobile/manifest, the Expo Updates protocol endpoint the phone app
(T3 Code (Owner)) polls on every launch. A binary's runtime version is its
native fingerprint, so the manifest is chosen by the request's
expo-platform and expo-runtime-version headers:
mobile/<platform>/<runtime>/manifest.json, written by build-mobile.sh publish.
No manifest for that runtime answers 204, the protocol's "no update".

  artifacts-server.py <port> <directory>
"""
import functools
import http.server
import os
import re
import sys

SAFE = re.compile(r"^[A-Za-z0-9._-]+$")


class Handler(http.server.SimpleHTTPRequestHandler):
    # Android's browser offers to install an APK only with this type.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".apk": "application/vnd.android.package-archive",
    }

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/mobile/manifest":
            return super().do_GET()
        platform = self.headers.get("expo-platform", "")
        runtime = self.headers.get("expo-runtime-version", "")
        if not SAFE.match(platform) or not SAFE.match(runtime):
            return self.send_error(400, "expo-platform and expo-runtime-version headers required")
        path = os.path.join(self.directory, "mobile", platform, runtime, "manifest.json")
        try:
            with open(path, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            body = None
        self.send_response(200 if body else 204)
        self.send_header("expo-protocol-version", "1")
        self.send_header("expo-sfv-version", "0")
        self.send_header("cache-control", "private, max-age=0")
        if body:
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)


if __name__ == "__main__":
    port, directory = int(sys.argv[1]), sys.argv[2]
    handler = functools.partial(Handler, directory=directory)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()

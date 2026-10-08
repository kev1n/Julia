# Brand icons

Julia's original SVG sources in `julia/` drive the platform renditions. Run `vp run icons:export` to regenerate desktop, web, iOS fallback, and Android assets, or `vp run icons:check` to verify that tracked exports match their sources. Do not edit the generated PNG or ICO files directly.

The macOS source owns the 824px opaque body inset 100px inside its 1024px canvas. Render it directly; resizing a full-bleed icon does not reproduce its safe area. The Android foreground owns its adaptive safe zone, and the splash uses the same proportions. `julia/app-icon.icon` carries the same vector mark for native iOS composition.

Release channels share the Julia mark. Stage labels distinguish development and nightly environments without changing the identity. The previous `dev/`, `nightly/`, and `prod/` assets are retained as upstream references, not inputs to Julia's exporter.

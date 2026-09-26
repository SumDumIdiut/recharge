# Game runner

A tiny Electron app that plays a Unity WebGL build in its own window. Recharge
downloads the Electron runtime on demand (it isn't bundled) and starts this:

    electron . --game "<build folder>" --title "<name>"

The build folder is the one with `index.html`, `Build/` and `TemplateData/`.
It's served from a local port so Brotli files (`*.br`) get the
`Content-Encoding` header they need. F11 toggles fullscreen.

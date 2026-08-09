# fleet-shell-win

BlackLabel's Windows UI shell — the "build once, whole fleet" pattern the
July 8 Circuit spike settled on (Tauri v2 default, electron-builder fallback).
One native window with dark chrome; every app surface in the fleet plugs in
as a URL.

## What it is

A minimal Tauri v2 app. The Rust side (`src-tauri/`) is a bare window host.
The frontend (`src/`) is plain HTML/JS chrome: it reads `src/fleet.json`,
renders one tab per app surface, and shows the active surface in an embedded
frame. No framework, no build step for the frontend.

## How AceOS plugs in

Run the AceOS transport locally so its dashboard is on `http://127.0.0.1:8765`,
then launch the shell. AceOS is the default surface in `fleet.json`, so it
loads on start. (Surfaces are iframed — they must not send
`X-Frame-Options: DENY`.)

## Adding the next surface (Estate, etc.)

Append an entry to `src/fleet.json` and rebuild:

```json
{ "id": "estate", "name": "Estate", "url": "http://127.0.0.1:9100" }
```

## Building

- **CI** — `.github/workflows/windows.yml` builds on `windows-latest` and
  uploads the NSIS installer artifact on every push.
- **Local** — needs Rust + Node: `npm ci`, then `npx tauri build`
  (or `npx tauri dev`).

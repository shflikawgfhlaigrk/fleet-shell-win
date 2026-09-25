# fleet-shell-win

BlackLabel's desktop UI shell for Windows and Linux: the "build once, whole
fleet" pattern the July 8 Circuit spike settled on (Tauri v2 by default,
electron-builder as the fallback). One native window with dark chrome; every
app surface in the fleet plugs in as a URL.

(The name predates the Linux build. Renaming the repo to `fleet-shell` is
proposed in the Linux PR and has not been done.)

## What it is

A small Tauri v2 app.

- `src-tauri/` is the window host. It has one command, `probe_surface`
  (`src-tauri/src/probe.rs`), which checks whether a surface's port answers
  before the shell tries to show it. It only probes loopback addresses.
- `src/` is plain HTML/JS chrome with no framework and no frontend build step.
  - `fleet.json` is the surface registry.
  - `registry.js` validates the registry.
  - `probe.js` turns probe results into "what failed / why / what to do next".
  - `motion.js` is the motion gate.
  - `main.js` wires it all together.

## Surfaces

| id | name | where | what serves it |
|---|---|---|---|
| `aceos` | AceOS (default) | `http://127.0.0.1:8765` (checked via `/api/capabilities`) | AceOS HQ server, `python run_hq_http.py` |
| `hq` | HQ | `http://127.0.0.1:8791` | BlackLabel HQ dashboard |
| `utah` | Utah deck | `http://127.0.0.1:8766` | Utah deck |
| `sovereign` | Sovereign | port read from `~/.sovereign/dashboard.port`, checked via `/api/health` → `{"ok": true}` | Sovereign daemon, `sov start` |
| `estate` | Estate API | `http://127.0.0.1:8787` | `npx wrangler dev` in BlackLabelRealEstateAPI (JSON, not a dashboard) |

`fleet.json` holds the sources and caveats for each entry (`notes`).

### When a surface isn't running

Each tab has a status dot: grey means not running, green running, amber
something else is on the port or it can't be framed, red an error, and blue
still checking. The dot's tooltip gives the same state as text. When the
active surface doesn't answer, the stage shows a panel with **What failed**,
**Why** and **What to do next** (the start command from `fleet.json`), plus a
**Retry** button. The panel replaces the blank frame. Each case is handled
separately:

- connection refused, or timed out
- port file missing, unreadable or invalid
- a WebSocket server holding the port (HTTP 426)
- a non-HTTP listener, or one that stays silent
- a health check that doesn't return `ok: true`
- HTTP errors (5xx and other statuses)
- `X-Frame-Options` / `frame-ancestors` refusing to be framed
- a misconfigured entry

Bad `fleet.json` entries are listed in a banner at the top, never silently dropped.

Surfaces are iframed, so they must not send `X-Frame-Options: DENY`. If one
does, the shell says so.

## Adding a surface

Append an entry to `src/fleet.json` and rebuild:

```json
{ "id": "leads", "name": "Leads", "url": "http://127.0.0.1:9100",
  "start": "Run `npm start` in BlackLabelLeadsAPI." }
```

The keys are:

- `url`, a loopback `http://` URL. Use it or `portFile`, not both.
- `portFile`, a file holding the port number. `~/` is allowed.
- `healthPath` and `expectOkJson`, both optional.
- `start`, shown as the next step when the surface is down.
- `portNote`, shown when another program holds the port.
- `notes`, a free-form record that the chrome ignores.

## Motion

Motion follows `BlackLabel-Team/CONTEXT/FLEET-MOTION-STANDARD-20260709.md`:

- It is off on a fresh profile.
- The **Motion** checkbox in the chrome turns it on, and the choice persists.
- Effective motion is `enabled && !prefers-reduced-motion`.
- `styles.css` animates only under `:root[data-motion="on"]`, and a test enforces that.

## Building

- **CI**:
  - `.github/workflows/windows.yml` runs on `windows-latest`: tests, then the NSIS installer.
  - `.github/workflows/linux.yml` runs on `ubuntu-latest`: tests, then the deb + AppImage, then an end-to-end run of the built binary under Xvfb. It uploads `e2e/out/` with screenshots and `report.json`.
- **Local**: needs Rust and Node 22.
  - `npm ci`
  - `npm test` for the JS tests.
  - `cd src-tauri && cargo test` for the Rust tests.
  - `npx tauri build` builds the app.
  - Linux also needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev patchelf`.
  - `src-tauri/tauri.linux.conf.json` switches Linux bundles to deb + AppImage.
- **End to end (Linux)**:
  - `apt install xvfb webkit2gtk-driver`
  - `cargo install tauri-driver --locked`
  - `xvfb-run -a npm run e2e`

# Record: Linux build + Xvfb run, 2026-09-25

This is what was run in the build VM and what it printed. The requirements
are in `docs/REQUIREMENTS-linux.md`.

## Environment
- Ubuntu 24.04.4 LTS, kernel `Linux 6.18.44-fc-v37 x86_64` (cloud VM, no GPU, Xvfb display)
- rustc 1.94.1, Node v22.22.2, webkit2gtk-4.1 2.52.6, tauri 2.11.6 (crate), @tauri-apps/cli 2.11.4, tauri-driver 2.0.6, WebKitWebDriver from `webkit2gtk-driver` 2.52.6

## Tests
```
$ npm test
# tests 45
# pass 45
# fail 0

$ cd src-tauri && cargo test --locked
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.81s

$ cargo fmt --check        # clean
$ cargo clippy --locked --all-targets -- -D warnings   # Finished, no warnings
```
To confirm the guard tests actually catch what they claim to, both were
broken on purpose:
- An ungated `#brand { transition: color 1s; }` appended to styles.css made
  the gate test fail: `ungated motion in "#brand"`.
- Renaming `http-5xx` to `http-teapot` in probe.rs made the contract test
  fail: `reason "http-teapot" has no explicit copy`.

Both files were restored afterwards.

## Build
```
$ npx tauri build
    Finished `release` profile [optimized] target(s) in 28.76s
    Bundling BlackLabel_0.1.0_amd64.deb
    Bundling BlackLabel_0.1.0_amd64.AppImage
    Finished 2 bundles

$ dpkg-deb -f BlackLabel_0.1.0_amd64.deb Depends
libwebkit2gtk-4.1-0, libgtk-3-0
```
The deb contains `usr/bin/fleet-shell`, `usr/share/applications/BlackLabel.desktop`,
and hicolor icons at 32, 128 and 256.

sha256 of the final build:
- deb      `808d86ecf81b6f437ed4e50cf1243e038c7dbd8e66751bfbe6a8f1031bc16abc`
- AppImage `98affaf905f57bf7f5c929874a81e431c728534e74ecfdd4407b8378d94de268`
- binary   `d6b1be37bb557c56387abf5d0b790756da179be41dac0a9cd98d5efea0bcd07f`

## End to end: the real release binary under Xvfb, empty profile
`xvfb-run -a --server-args="-screen 0 1280x800x24" npm run e2e`. The run
used a fresh temp HOME and drove the app through tauri-driver and
WebKitWebDriver. `report.json` is next to this file.
```
PASS  window title
PASS  tabs
PASS  AceOS not running panel title  -- "AceOS: Not running"
PASS  what failed names the address  -- "AceOS is not running: nothing is listening at http://127.0.0.1:8765."
PASS  why is present  -- "The connection was refused, so no program is serving that port."
PASS  next step is present  -- "Start the AceOS HQ server: run `python run_hq_http.py` in the AceOS repo (on the Mac, launchd runs it as com.ace.hq_http)."
PASS  iframe not shown
PASS  every tab probed as down  -- ["down","down","down","down","down"]
PASS  motion off on empty profile
PASS  motion toggle unchecked on empty profile
PASS  Sovereign not running (no port file)  -- "Sovereign is not running: its port file /tmp/fleet-e2e-home-2thXNi/.sovereign/dashboard.port does not exist."
PASS  AceOS framed once running  -- "http://127.0.0.1:8765"
PASS  panel hidden when running
PASS  AceOS dot is up
PASS  Utah deck port held by a WebSocket server  -- "Utah deck: Something else is on this port"
PASS  Utah explains the AceOS WebSocket clash  -- "http://127.0.0.1:8766/ answered 426 Upgrade Required (a WebSocket server, not a dashboard). ..."
PASS  Sovereign found through ~/.sovereign/dashboard.port  -- 8779
PASS  toggle ON opens the gate (unless system Reduce Motion)  -- "on"
PASS  toggle ON persisted
PASS  toggle OFF closes the gate
PASS  no running CSS animations with motion off
PASS: 21/21 checks
```
The "running" states used **loopback fixtures** (small Node HTTP servers)
standing in for AceOS, a WebSocket server on 8766, and Sovereign on 8779.
None of the real dashboards ran in this VM. See "Not proven" below.

## Screenshots
- `0-appimage-launch.png`: the AppImage launched directly
  (`--appimage-extract-and-run`) on a bare Xvfb display, showing the AceOS
  not-running panel. It was taken from the first build, sha256 `376a8486…`.
  That build's only difference from the final one was a duplicated
  `Depends` line in the deb.
- `1-aceos-not-running.png`
- `2-sovereign-not-running.png`
- `3-aceos-running.png` (fixture framed)
- `4-utah-wrong-service.png`
- `5-sovereign-running.png` (fixture found via the port file)

## Not proven
- **No real desktop.** This ran on Xvfb with no GPU (libEGL warned about
  DRI3 and fell back to software rendering). Not checked on a real
  GNOME/KDE session:
  - Wayland
  - HiDPI scaling
  - tray and taskbar behaviour
  - whether the system Reduce Motion setting (GTK `gtk-enable-animations`)
    reaches `prefers-reduced-motion` in WebKitGTK. Under Xvfb it read
    `false`; the toggle logic is unit-tested with a stubbed matchMedia.
- **Real dashboards.** None of AceOS, HQ, the Utah deck, Sovereign or the
  Estate worker was running here. Nothing proves that each one:
  - answers on its listed port on Linux
  - serves a page at `/`
  - allows framing

  Sovereign's daemon is launchd-managed on the Mac, and whether it runs on
  Linux at all is unknown.
- **HQ :8791 and Utah deck :8766 start commands** are unverified. The
  BlackLabelHQ repo couldn't be attached in this session (permission
  refused). The `utah` repo is a Swift app, not the deck.
- **Windows.** The new code has not run on a Windows machine yet; the
  Windows CI job is its first run. Windows retries a closed loopback port
  for about 2 s, so a down surface there may read "did not answer in time"
  rather than "refused". The Rust tests accept either on Windows.
- **Icons.** The PNG icons are the existing 32 px `.ico` upscaled
  (placeholder). A real source icon is needed for the deb/AppImage menus.
- **Signing.** The deb and AppImage are unsigned.

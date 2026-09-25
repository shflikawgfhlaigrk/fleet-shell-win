# Record 2: Real Estate + Marketing surfaces, 2026-09-25 (after 21:24 UTC)

This run followed the planning session's request to register Real Estate
(lane P3) and Marketing (lane P6). The first record (`RECORD.md`) is left
as it was.

## Where the surface details came from
I read them from the two draft PRs, attached read-only:
- **BlackLabelRealEstate#4**, `web/server.mjs`:
  - `DEFAULT_PORT = 4178`, `BLRE_WEB_PORT` overrides it, and it binds `127.0.0.1`.
  - `/healthz` returns `{ ok: true, service: "blacklabel-realestate-web" }`.
  - Its CSP has no `frame-ancestors`, and it sends no `X-Frame-Options`, so the shell can frame it.
- **BlackLabelMarketing#8**, `web/server/server.mjs`:
  - `DEFAULT_PORT = 47310`, `BL_MARKETING_WEB_PORT` overrides it, and it binds `127.0.0.1`.
  - Only the hosts `127.0.0.1:<port>` and `localhost:<port>` are answered; any other gets 421.
  - `/api/*` without `x-bl-surface: marketing` gets 403.
  - `GET /api/health` returns `{ ok: true, surface: "marketing", ... }`.
  - `/` needs no header and sends no frame-blocking header.
  - `web/package.json` has `"start": "node server/server.mjs"`.

The probe sends `x-bl-surface` on the health request only. The framed page
gets no extra header, which is also true of the real iframe.

## Tests
```
$ npm test
# tests 50
# pass 50
# fail 0

$ cd src-tauri && cargo test --locked
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.81s

$ cargo fmt --check                                     # clean
$ cargo clippy --locked --all-targets -- -D warnings    # clean
```
The new Rust tests cover:
- the header is sent on health only and never on the frame request
- CR/LF injection, bad names, and `Host`/`Content-Length` overrides are all refused before any socket opens
- `expectFields` passes, fails on a mismatch, and fails on a non-JSON body
- HTTP 421

Before I added messages for the new reason codes, the contract test failed
on them (`reason "http-421" has no explicit copy`).

## Build
`npx tauri build` built the deb and AppImage. sha256:
- deb      `e835730e02b506d78a05df72ab8734ebfe97d19555d5deecf1e244e1623e14d8`
- AppImage `76f73480c8aec2eadff872862bd89e3e8559ec59c6dd59142153ce8f629dfa09`
- binary   `aec4c77c704eee9bff40eb37bc4267c3472ee5e6d862aff67464f597b8e91b7c`

## End to end: release binary under Xvfb, empty profile (`report-2.json`)
The stand-in servers copy each product's guards from the PR source: Real
Estate's `/healthz` and CSP, and Marketing's Host allow-list plus its
`x-bl-surface` check. The stand-ins stood in for the real product servers;
the products themselves did not run.
```
PASS  window title
PASS  tabs
PASS  AceOS not running panel title  -- "AceOS: Not running"
PASS  what failed names the address  -- "AceOS is not running: nothing is listening at http://127.0.0.1:8765."
PASS  why is present  -- "The connection was refused, so no program is serving that port."
PASS  next step is present  -- "Start the AceOS HQ server: run `python run_hq_http.py` in the AceOS repo (on the Mac, launchd runs it as com.ace.hq_http)."
PASS  iframe not shown
PASS  every tab probed as down  -- ["down","down","down","down","down","down","down"]
PASS  motion off on empty profile
PASS  motion toggle unchecked on empty profile
PASS  Sovereign not running (no port file)  -- "Sovereign is not running: its port file /tmp/fleet-e2e-home-txesJx/.sovereign/dashboard.port does not exist."
PASS  Marketing not running names :47310 and its start command  -- "Marketing is not running: nothing is listening at http://127.0.0.1:47310."
PASS  AceOS framed once running  -- "http://127.0.0.1:8765"
PASS  panel hidden when running
PASS  AceOS dot is up
PASS  Utah deck port held by a WebSocket server  -- "Utah deck: Something else is on this port"
PASS  Utah explains the AceOS WebSocket clash  -- "http://127.0.0.1:8766/ answered 426 Upgrade Required (a WebSocket server, not a dashboard). ..."
PASS  Sovereign found through ~/.sovereign/dashboard.port  -- 8779
PASS  Real Estate framed after /healthz names the service
PASS  Marketing health probe carried x-bl-surface: marketing  -- {"path":"/api/health","surfaceHeader":"marketing"}
PASS  Marketing framed
PASS  toggle ON opens the gate (unless system Reduce Motion)  -- "on"
PASS  toggle ON persisted
PASS  toggle OFF closes the gate
PASS  no running CSS animations with motion off
PASS: 25/25 checks
```
Screenshots: `2b-marketing-not-running.png`, `6-marketing-running.png`.

## Not proven
- **The real product servers never ran here.** It is unverified that
  `node web/server.mjs` and `npm start` actually serve these routes on
  Linux or Windows; this run used stand-ins built from the PR source.
- **Both product PRs are drafts.** If the port, health body or header
  changes before they merge, `src/fleet.json` must follow.
- **Port overrides.** A surface moved with `BLRE_WEB_PORT` or
  `BL_MARKETING_WEB_PORT` shows "Not running" at the default port. Each
  entry's `portNote` says to update its `url`.

# Requirements: fleet shell on Linux (lane W10)

This file says what the Linux shell must do. It records no results; those
are in `docs/records/`.

## R1. Linux build
- R1.1 Tauri v2 shell builds on Linux against webkit2gtk-4.1.
- R1.2 Bundles: `.deb` and `.AppImage` (`src-tauri/tauri.linux.conf.json`).
  Windows keeps the NSIS target unchanged (`tauri.conf.json`).
- R1.3 CI: an `ubuntu-latest` job beside the `windows-latest` job, running
  JS tests, Rust tests, the bundle build, and an end-to-end run of the
  built binary under Xvfb.

## R2. Surfaces (`src/fleet.json`)
- R2.1 AceOS `127.0.0.1:8765` (default), HQ `127.0.0.1:8791`, Utah deck
  `127.0.0.1:8766`, Sovereign (port from `~/.sovereign/dashboard.port`),
  Real Estate web `127.0.0.1:4178` (health `/healthz`, service
  `blacklabel-realestate-web`), Marketing web `127.0.0.1:47310` (health
  `/api/health`, which needs the header `x-bl-surface: marketing`), and
  Estate API `127.0.0.1:8787`. Real Estate and Marketing were added at the
  planning session's request (2026-09-25 21:24 UTC).
- R2.4 The shell only points at the product servers. It does not start,
  bundle or edit them.
- R2.2 Only loopback `http://` surfaces. The Rust probe refuses anything
  else before opening a socket.
- R2.3 Invalid entries are listed in a visible banner, not dropped silently.

## R3. No silent failures
- R3.1 A surface that doesn't answer shows "Not running" with **what
  failed**, **why**, and **what to do next** (its start command), plus
  Retry. It never shows a blank frame.
- R3.2 Each of these is its own state with its own copy:
  - refused
  - timeout
  - port file missing, unreadable or invalid
  - a WebSocket server on the port
  - non-HTTP or silent listener
  - health check not ok
  - HTTP 5xx and other statuses
  - frame refused (`X-Frame-Options` / `frame-ancestors`)
  - bad entry
  - IPC failure
  - an unknown result
- R3.3 Every tab carries a probed status dot, with the same state as text.

## R4. Motion (FLEET-MOTION-STANDARD-20260709)
- R4.1 Off on a fresh profile.
- R4.2 A visible toggle keeps motion as a feature, and the choice persists.
- R4.3 Every animation and transition is gated on
  `:root[data-motion="on"]`.
- R4.4 Effective motion = enabled && !prefers-reduced-motion.
- R4.5 The static look keeps its colours and shadows.

## R5. Tests
- R5.1 Every source file is covered: `probe.rs` (Rust unit tests);
  `registry.js`, `probe.js`, `motion.js`, `main.js` (node:test + jsdom);
  `index.html`, `styles.css`, `fleet.json` (contract tests).
- R5.2 A contract test fails if `probe.rs` gains a reason code without
  matching copy in `probe.js`.
- R5.3 CI is green on Windows and Linux.

## Constraints
- Mac behaviour must not change. This repo has no Mac build, and no Mac
  code was touched.
- Draft PR only, on a `claude/` branch.

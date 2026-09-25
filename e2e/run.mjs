// End-to-end check of the real built shell binary, driven over WebDriver
// (tauri-driver -> WebKitWebDriver). Linux only; run under a display, e.g.
//   xvfb-run -a npm run e2e
//
// It starts from an empty profile (a temp HOME), so it also proves the
// motion gate ships off. Loopback fixtures stand in for the dashboards:
//   phase 1: nothing listening        -> AceOS shows "Not running"
//   phase 2: fixtures come up         -> Retry frames AceOS; Utah's port holds a
//                                        WebSocket server (426); Sovereign is found
//                                        through its port file
// Writes e2e/out/report.json and screenshots. Exits non-zero on any failure.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BIN = process.env.FLEET_SHELL_BIN || join(ROOT, "src-tauri/target/release/fleet-shell");
const OUT = join(ROOT, "e2e/out");
const DRIVER = process.env.TAURI_DRIVER || "tauri-driver";
const WD = "http://127.0.0.1:4444";
const SOVEREIGN_PORT = 8779;

mkdirSync(OUT, { recursive: true });
const report = { binary: BIN, startedAt: new Date().toISOString(), checks: [] };
const children = [];
const servers = [];

function check(name, pass, detail) {
  report.checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  -- ${JSON.stringify(detail)}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(WD + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json.value)}`);
  return json.value;
}

async function waitFor(what, fn, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

function listen(port, handler) {
  return new Promise((res, rej) => {
    const s = createServer(handler);
    s.once("error", rej);
    s.listen(port, "127.0.0.1", () => { servers.push(s); res(s); });
  });
}

async function main() {
  if (!existsSync(BIN)) throw new Error(`binary not found: ${BIN} (run \`npx tauri build\` first)`);

  const home = mkdtempSync(join(tmpdir(), "fleet-e2e-home-"));
  report.home = home;
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local/share"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") };

  const driver = spawn(DRIVER, ["--port", "4444"], { env, stdio: ["ignore", "inherit", "inherit"] });
  children.push(driver);
  await waitFor("tauri-driver", async () => (await fetch(WD + "/status")).ok, 15000);

  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: BIN } } },
  });
  const sid = session.sessionId;
  const S = `/session/${sid}`;
  const js = (script, args = []) => wd("POST", `${S}/execute/sync`, { script, args });
  const text = (id) => js(`return document.getElementById(arguments[0]).textContent`, [id]);
  const shot = async (name) => {
    const b64 = await wd("GET", `${S}/screenshot`);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(b64, "base64"));
  };

  try {
    // ---- Phase 1: empty profile, nothing listening ----
    await waitFor("AceOS probe result", async () =>
      (await js(`return document.getElementById("panel").dataset.tone`)) === "down");
    check("window title", (await wd("GET", `${S}/title`)) === "BlackLabel");
    check("tabs", (await js(`return [...document.querySelectorAll("#surfaces button")].map(b => b.textContent)`)).join("|") === "AceOS|HQ|Utah deck|Sovereign|Estate API");
    const title = await text("panel-title");
    check("AceOS not running panel title", title === "AceOS: Not running", title);
    const what = await text("panel-what");
    check("what failed names the address", /nothing is listening at http:\/\/127\.0\.0\.1:8765/.test(what), what);
    check("why is present", /refused/.test(await text("panel-why")), await text("panel-why"));
    check("next step is present", /run_hq_http\.py/.test(await text("panel-next")), await text("panel-next"));
    check("iframe not shown", (await js(`return getComputedStyle(document.getElementById("surface")).display`)) === "none");
    const tones = await waitFor("all tab dots probed", async () => {
      const t = await js(`return [...document.querySelectorAll("#surfaces button")].map(b => b.dataset.tone)`);
      return t.every((x) => x && x !== "checking") ? t : null;
    });
    check("every tab probed as down", tones.every((t) => t === "down"), tones);
    check("motion off on empty profile", (await js(`return document.documentElement.dataset.motion`)) === "off");
    check("motion toggle unchecked on empty profile", (await js(`return document.getElementById("motion-toggle").checked`)) === false);
    report.reduceMotionSystem = await js(`return matchMedia("(prefers-reduced-motion: reduce)").matches`);
    await shot("1-aceos-not-running");

    await js(`document.querySelector('#surfaces button[data-id="sovereign"]').click()`);
    await waitFor("Sovereign panel", async () => (await text("panel-title")) === "Sovereign: Not running");
    check("Sovereign not running (no port file)", /dashboard\.port does not exist/.test(await text("panel-what")), await text("panel-what"));
    await shot("2-sovereign-not-running");

    // ---- Phase 2: bring fixtures up ----
    await listen(8765, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><body style="background:#123;color:#fff;font:20px sans-serif"><h1 id="fixture">AceOS fixture</h1></body>`);
    });
    const utah = await listen(8766, (req, res) => { res.writeHead(426, { upgrade: "websocket" }); res.end(); });
    void utah;
    await listen(SOVEREIGN_PORT, (req, res) => {
      if (req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok": true}'); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><body style="background:#221;color:#fff;font:20px sans-serif"><h1>Sovereign fixture</h1></body>`);
    });
    mkdirSync(join(home, ".sovereign"), { recursive: true });
    writeFileSync(join(home, ".sovereign/dashboard.port"), `${SOVEREIGN_PORT}\n`);

    await js(`document.querySelector('#surfaces button[data-id="aceos"]').click()`);
    await waitFor("AceOS framed", async () => (await js(`return document.getElementById("surface").getAttribute("src")`)) === "http://127.0.0.1:8765", 10000);
    check("AceOS framed once running", true, await js(`return document.getElementById("surface").getAttribute("src")`));
    check("panel hidden when running", (await js(`return document.getElementById("panel").hidden`)) === true);
    check("AceOS dot is up", (await js(`return document.querySelector('#surfaces button[data-id="aceos"]').dataset.tone`)) === "up");
    await sleep(800);
    await shot("3-aceos-running");

    await js(`document.querySelector('#surfaces button[data-id="utah"]').click()`);
    await waitFor("Utah result", async () => (await js(`return document.getElementById("panel").dataset.tone`)) === "warn");
    check("Utah deck port held by a WebSocket server", (await text("panel-title")) === "Utah deck: Something else is on this port", await text("panel-title"));
    check("Utah explains the AceOS WebSocket clash", /ws_server\.py/.test(await text("panel-why")), await text("panel-why"));
    await shot("4-utah-wrong-service");

    await js(`document.querySelector('#surfaces button[data-id="sovereign"]').click()`);
    await waitFor("Sovereign framed via port file", async () =>
      (await js(`return document.getElementById("surface").getAttribute("src")`)) === `http://127.0.0.1:${SOVEREIGN_PORT}`, 10000);
    check("Sovereign found through ~/.sovereign/dashboard.port", true, SOVEREIGN_PORT);
    await sleep(800);
    await shot("5-sovereign-running");

    // ---- Motion toggle on the real binary ----
    await js(`const t = document.getElementById("motion-toggle"); t.click();`);
    const on = await js(`return document.documentElement.dataset.motion`);
    check("toggle ON opens the gate (unless system Reduce Motion)", on === (report.reduceMotionSystem ? "off" : "on"), on);
    check("toggle ON persisted", (await js(`return localStorage.getItem("fleet.motionEnabled")`)) === "true");
    await js(`document.getElementById("motion-toggle").click();`);
    check("toggle OFF closes the gate", (await js(`return document.documentElement.dataset.motion`)) === "off");
    check("no running CSS animations with motion off", (await js(`return document.getAnimations().length`)) === 0);
  } finally {
    await wd("DELETE", S).catch(() => {});
  }
}

let failed = false;
try {
  await main();
} catch (e) {
  check("e2e run", false, String(e.stack || e));
}
failed = report.checks.some((c) => !c.pass);
report.finishedAt = new Date().toISOString();
report.result = failed ? "FAIL" : "PASS";
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
for (const s of servers) s.close();
for (const c of children) c.kill();
console.log(`\n${report.result}: ${report.checks.filter((c) => c.pass).length}/${report.checks.length} checks`);
process.exit(failed ? 1 : 0);

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createShell, boot } from "../src/main.js";
import { makeDom, text, tick } from "./helpers.js";

const fleet = JSON.parse(readFileSync(new URL("../src/fleet.json", import.meta.url), "utf8"));

// Fake Rust side: everything down unless listed in `up`.
function fakeInvoke(up = {}, calls = []) {
  return async (cmd, { target }) => {
    calls.push(target);
    const key = target.url || target.portFile;
    if (up[key]) return { state: "up", reason: "ok", detail: "HTTP 200", url: up[key], httpStatus: 200 };
    if (target.portFile) {
      return { state: "down", reason: "port-file-missing", detail: "/home/t/.sovereign/dashboard.port", url: null };
    }
    return { state: "down", reason: "refused", detail: `${key.slice(7)}: Connection refused (os error 111)`, url: key };
  };
}

function shell(win, opts = {}) {
  const store = new Map();
  const storage = opts.storage || { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  return createShell({
    doc: win.document,
    win,
    storage,
    invoke: opts.invoke || fakeInvoke(),
    loadFleet: opts.loadFleet || (async () => fleet),
  });
}

test("with nothing running, AceOS shows the not-running panel, not a blank frame", async () => {
  const win = makeDom();
  const s = shell(win);
  await s.boot();
  const doc = win.document;
  assert.equal(doc.getElementById("panel").hidden, false);
  assert.equal(doc.getElementById("panel").dataset.tone, "down");
  assert.equal(text(win, "panel-title"), "AceOS: Not running");
  assert.equal(text(win, "panel-what-k"), "What failed");
  assert.match(text(win, "panel-what"), /nothing is listening at http:\/\/127\.0\.0\.1:8765/);
  assert.match(text(win, "panel-why"), /refused/);
  assert.match(text(win, "panel-next"), /run_hq_http\.py/);
  assert.equal(doc.getElementById("panel-retry").hidden, false);
  assert.equal(doc.getElementById("surface").style.display, "none");
  assert.equal(doc.getElementById("surface").getAttribute("src"), null);
  assert.equal(text(win, "status"), "AceOS: Not running");
});

test("every tab gets a probed state dot", async () => {
  const win = makeDom();
  await shell(win).boot();
  await tick();
  const tabs = [...win.document.querySelectorAll("#surfaces button")];
  assert.deepEqual(tabs.map((b) => b.textContent), ["AceOS", "HQ", "Utah deck", "Sovereign", "Real Estate", "Marketing", "Estate API"]);
  for (const b of tabs) {
    assert.equal(b.dataset.tone, "down", b.textContent);
    assert.equal(b.title, "Not running");
    assert.equal(b.querySelector(".dot").getAttribute("aria-label"), "Not running");
  }
  assert.equal(tabs[0].classList.contains("active"), true);
  assert.equal(tabs[0].getAttribute("aria-pressed"), "true");
});

test("a running surface is framed at the probed URL", async () => {
  const win = makeDom();
  await shell(win, { invoke: fakeInvoke({ "http://127.0.0.1:8765": "http://127.0.0.1:8765" }) }).boot();
  const frame = win.document.getElementById("surface");
  assert.equal(frame.style.display, "block");
  assert.equal(frame.getAttribute("src"), "http://127.0.0.1:8765");
  assert.equal(win.document.getElementById("panel").hidden, true);
  assert.equal(text(win, "status"), "http://127.0.0.1:8765");
});

test("Sovereign frames the port its port file names", async () => {
  const win = makeDom();
  const s = shell(win, { invoke: fakeInvoke({ "~/.sovereign/dashboard.port": "http://127.0.0.1:8771" }) });
  await s.boot();
  await s.activate("sovereign");
  assert.equal(win.document.getElementById("surface").getAttribute("src"), "http://127.0.0.1:8771");
});

test("Sovereign without a port file explains it is not running", async () => {
  const win = makeDom();
  const s = shell(win);
  await s.boot();
  await s.activate("sovereign");
  assert.equal(text(win, "panel-title"), "Sovereign: Not running");
  assert.match(text(win, "panel-what"), /port file .*dashboard\.port does not exist/);
  assert.match(text(win, "panel-next"), /sov start/);
});

test("Retry re-probes and frames the surface once it is up", async () => {
  const win = makeDom();
  const up = {};
  const calls = [];
  const s = shell(win, { invoke: fakeInvoke(up, calls) });
  await s.boot();
  assert.equal(text(win, "panel-title"), "AceOS: Not running");
  up["http://127.0.0.1:8765"] = "http://127.0.0.1:8765";
  const before = calls.length;
  win.document.getElementById("panel-retry").click();
  await tick(); await tick();
  assert.equal(calls.length, before + 1);
  assert.equal(win.document.getElementById("surface").getAttribute("src"), "http://127.0.0.1:8765");
  assert.equal(win.document.querySelector('#surfaces button[data-id="aceos"]').dataset.tone, "up");
});

test("while checking, the panel says so and offers no retry", async () => {
  const win = makeDom();
  let release;
  const gate = new Promise((r) => (release = r));
  const s = shell(win, { invoke: async (c, a) => { await gate; return fakeInvoke()(c, a); } });
  const booting = s.boot();
  await tick();
  assert.equal(win.document.getElementById("panel").dataset.tone, "checking");
  assert.equal(text(win, "panel-what-k"), "Status");
  assert.equal(win.document.getElementById("panel-retry").hidden, true);
  assert.equal(win.document.querySelector('#surfaces button[data-id="aceos"]').dataset.tone, "checking");
  release();
  await booting;
  assert.equal(win.document.getElementById("panel").dataset.tone, "down");
});

test("a slow probe for an old tab does not overwrite the tab the user switched to", async () => {
  const win = makeDom();
  const pending = [];
  const s = shell(win, {
    invoke: (c, a) => new Promise((res) => pending.push(() => res(fakeInvoke({ "http://127.0.0.1:8791": "http://127.0.0.1:8791" })(c, a)))),
  });
  s.boot();
  await tick();
  s.activate("hq");
  await tick();
  // Resolve everything: HQ is up, AceOS (the stale activation) is down.
  while (pending.length) pending.shift()();
  await tick(); await tick(); await tick();
  assert.equal(s.state.active, "hq");
  assert.equal(win.document.getElementById("surface").getAttribute("src"), "http://127.0.0.1:8791");
  assert.equal(win.document.getElementById("panel").hidden, true);
});

test("fleet.json failing to load says what, why and next", async () => {
  const win = makeDom();
  await shell(win, { loadFleet: async () => { throw new SyntaxError("Unexpected token } in JSON"); } }).boot();
  assert.equal(win.document.getElementById("panel").hidden, false);
  assert.equal(text(win, "panel-title"), "fleet.json could not be loaded");
  assert.match(text(win, "panel-why"), /Unexpected token/);
  assert.match(text(win, "panel-next"), /Restore src\/fleet\.json/);
  assert.equal(text(win, "status"), "fleet.json missing or invalid");
});

test("bad registry entries are listed, good ones still load", async () => {
  const win = makeDom();
  const raw = { surfaces: [{ id: "lan", name: "LAN", url: "http://10.0.0.5:80" }, fleet.surfaces[0]] };
  await shell(win, { loadFleet: async () => raw }).boot();
  const box = win.document.getElementById("registry-errors");
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /surface #1 \("lan"\): url must be http:\/\/ on 127\.0\.0\.1/);
  assert.equal(win.document.querySelectorAll("#surfaces button").length, 1);
});

test("an empty registry shows the empty-state message", async () => {
  const win = makeDom();
  await shell(win, { loadFleet: async () => ({ surfaces: [] }) }).boot();
  assert.equal(win.document.getElementById("empty").style.display, "flex");
  assert.equal(win.document.getElementById("panel").hidden, true);
  assert.equal(text(win, "status"), "no surfaces");
});

test("motion: off on a fresh profile, toggle turns it on and persists", async () => {
  const win = makeDom();
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  await shell(win, { storage }).boot();
  const root = win.document.documentElement;
  const toggle = win.document.getElementById("motion-toggle");
  assert.equal(root.dataset.motion, "off");
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  toggle.dispatchEvent(new win.Event("change"));
  assert.equal(root.dataset.motion, "on");
  assert.equal(store.get("fleet.motionEnabled"), "true");
  toggle.checked = false;
  toggle.dispatchEvent(new win.Event("change"));
  assert.equal(root.dataset.motion, "off");
});

test("motion: system Reduce Motion keeps the gate closed even when enabled", async () => {
  const win = makeDom({ reduceMotion: true });
  const storage = { getItem: () => "true", setItem() {} };
  await shell(win, { storage }).boot();
  const root = win.document.documentElement;
  assert.equal(root.dataset.motion, "off");
  assert.match(win.document.getElementById("motion-toggle").title, /Reduce Motion/);
  win.setReduceMotion(false);
  assert.equal(root.dataset.motion, "on");
  win.setReduceMotion(true);
  assert.equal(root.dataset.motion, "off");
});

test("boot() outside the shell reports the missing bridge instead of hanging", async () => {
  const win = makeDom();
  win.fetch = async () => ({ ok: true, json: async () => ({ surfaces: [fleet.surfaces[0]] }) });
  const s = await boot(win);
  assert.equal(s.state.results.aceos.reason, "ipc-missing");
  assert.equal(text(win, "panel-title"), "AceOS: Error");
  assert.match(text(win, "panel-why"), /__TAURI__/);
});

test("boot() wires window.__TAURI__.core.invoke and reports HTTP errors loading fleet.json", async () => {
  const win = makeDom();
  const calls = [];
  win.__TAURI__ = { core: { invoke: fakeInvoke({}, calls) } };
  win.fetch = async () => ({ ok: true, json: async () => ({ surfaces: [fleet.surfaces[0]] }) });
  await boot(win);
  assert.equal(calls.length, 1);

  const win2 = makeDom();
  win2.fetch = async () => ({ ok: false, status: 404 });
  await boot(win2);
  assert.match(text(win2, "panel-why"), /fleet\.json: HTTP 404/);
});

test("Real Estate and Marketing show the not-running panel with their start commands", async () => {
  const win = makeDom();
  const calls = [];
  const s = shell(win, { invoke: fakeInvoke({}, calls) });
  await s.boot();
  await s.activate("realestate");
  assert.equal(text(win, "panel-title"), "Real Estate: Not running");
  assert.match(text(win, "panel-what"), /nothing is listening at http:\/\/127\.0\.0\.1:4178/);
  assert.match(text(win, "panel-next"), /node web\/server\.mjs/);
  await s.activate("marketing");
  assert.equal(text(win, "panel-title"), "Marketing: Not running");
  assert.match(text(win, "panel-what"), /http:\/\/127\.0\.0\.1:47310/);
  assert.match(text(win, "panel-next"), /npm ci && npm start/);
  const m = calls.filter((t) => t.url === "http://127.0.0.1:47310").at(-1);
  assert.deepEqual(m.healthHeaders, { "x-bl-surface": "marketing" }, "the probe carries the surface header");
});

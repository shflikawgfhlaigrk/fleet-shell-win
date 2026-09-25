import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probe, describe, where } from "../src/probe.js";

const aceos = { id: "aceos", name: "AceOS", url: "http://127.0.0.1:8765", start: "Run `python run_hq_http.py`." };
const sov = { id: "sovereign", name: "Sovereign", portFile: "~/.sovereign/dashboard.port", start: "Run `sov start`." };
const utah = { id: "utah", name: "Utah deck", url: "http://127.0.0.1:8766", portNote: "AceOS WS defaults to 8766." };

test("probe calls the Rust command with the surface's target", async () => {
  const calls = [];
  const r = await probe(aceos, async (cmd, args) => {
    calls.push([cmd, args]);
    return { state: "up", reason: "ok", detail: "HTTP 200", url: aceos.url, httpStatus: 200 };
  });
  assert.equal(r.state, "up");
  assert.equal(calls[0][0], "probe_surface");
  assert.equal(calls[0][1].target.url, aceos.url);
});

test("probe without the Tauri bridge reports it instead of failing silently", async () => {
  const r = await probe(aceos, undefined);
  assert.equal(r.state, "error");
  assert.equal(r.reason, "ipc-missing");
  assert.match(describe(aceos, r).what, /could not check AceOS/);
});

test("probe turns an IPC exception into a result", async () => {
  const r = await probe(aceos, async () => { throw new Error("command probe_surface not found"); });
  assert.equal(r.reason, "ipc-failed");
  assert.match(r.detail, /not found/);
});

test("not running: names the address, the cause, and the start command", () => {
  const d = describe(aceos, { state: "down", reason: "refused", detail: "127.0.0.1:8765: Connection refused", url: aceos.url });
  assert.equal(d.tone, "down");
  assert.equal(d.label, "Not running");
  assert.match(d.what, /AceOS is not running: nothing is listening at http:\/\/127\.0\.0\.1:8765/);
  assert.match(d.why, /refused/);
  assert.equal(d.next, aceos.start);
});

test("not running via a missing port file", () => {
  const d = describe(sov, { state: "down", reason: "port-file-missing", detail: "/home/m/.sovereign/dashboard.port", url: null });
  assert.equal(d.label, "Not running");
  assert.match(d.what, /port file \/home\/m\/\.sovereign\/dashboard\.port does not exist/);
  assert.equal(d.next, sov.start);
});

test("a WebSocket server on the deck's port says who probably holds it", () => {
  const d = describe(utah, { state: "wrongService", reason: "http-426", detail: "426 Upgrade Required", url: utah.url });
  assert.equal(d.tone, "warn");
  assert.match(d.why, /AceOS WS defaults to 8766/);
});

test("a different service on the port is named, with the field that gave it away", () => {
  const re = { id: "realestate", name: "Real Estate", url: "http://127.0.0.1:4178", start: "Run `node web/server.mjs`." };
  const d = describe(re, {
    state: "wrongService", reason: "health-mismatch",
    detail: 'http://127.0.0.1:4178 /healthz returned service = "other", expected "blacklabel-realestate-web"', url: re.url,
  });
  assert.equal(d.tone, "warn");
  assert.match(d.what, /is not Real Estate/);
  assert.match(d.why, /expected "blacklabel-realestate-web"/);
  assert.match(d.next, /node web\/server\.mjs/);
});

test("a 421 tells you the host/port in fleet.json doesn't match", () => {
  const m = { id: "marketing", name: "Marketing", url: "http://127.0.0.1:47310" };
  const d = describe(m, { state: "wrongService", reason: "http-421", detail: "answered 421 Misdirected Request", url: m.url });
  assert.match(d.what, /Marketing refused the address/);
  assert.match(d.next, /src\/fleet\.json/);
});

test("surfaces without a start hint still get a next step", () => {
  const d = describe({ id: "x", name: "X", url: "http://127.0.0.1:1" }, { state: "down", reason: "refused", detail: "" });
  assert.equal(d.next, "Start X, then press Retry.");
});

test("no result yet means checking", () => {
  const d = describe(aceos, null);
  assert.equal(d.tone, "checking");
  assert.match(d.what, /Checking http:\/\/127\.0\.0\.1:8765/);
});

test("an unknown reason still produces what, why and next", () => {
  const d = describe(aceos, { state: "martian", reason: "cosmic-ray", detail: "bit flip" });
  assert.equal(d.tone, "error");
  assert.match(d.what, /Unrecognised check result for AceOS \(martian\/cosmic-ray\)/);
  assert.equal(d.why, "bit flip");
  assert.ok(d.next);
});

test("where prefers the probed URL, then url, then portFile", () => {
  assert.equal(where(sov, { url: "http://127.0.0.1:8771" }), "http://127.0.0.1:8771");
  assert.equal(where(aceos, null), aceos.url);
  assert.equal(where(sov, null), sov.portFile);
});

// Contract with src-tauri/src/probe.rs: every reason Rust can emit has its
// own explanation here (none fall through to "Unrecognised").
test("every reason code in probe.rs has explicit copy", () => {
  const rs = readFileSync(new URL("../src-tauri/src/probe.rs", import.meta.url), "utf8");
  const src = rs.split("#[cfg(test)]")[0];
  const reasons = new Set();
  for (const m of src.matchAll(/ProbeState::\w+,\s*"([a-z0-9-]+)"/g)) reasons.add(m[1]);
  for (const m of src.matchAll(/=>\s*"([a-z0-9-]+)"/g)) reasons.add(m[1]);
  for (const m of src.matchAll(/Some\(\("([a-z0-9-]+)"/g)) reasons.add(m[1]);
  for (const m of src.matchAll(/Err\(\(\s*"([a-z0-9-]+)"/g)) reasons.add(m[1]);
  for (const m of src.matchAll(/\(\s*"([a-z0-9-]+)",\s*format!/g)) reasons.add(m[1]);
  assert.ok(reasons.size >= 20, `found ${reasons.size} reasons: ${[...reasons]}`);
  for (const reason of reasons) {
    const d = describe(aceos, { state: "error", reason, detail: "d", url: aceos.url });
    assert.doesNotMatch(d.what, /Unrecognised/, `reason "${reason}" has no explicit copy`);
    if (reason !== "ok") {
      assert.ok(d.what && d.why && d.next, `reason "${reason}" gives what/why/next`);
    }
  }
});

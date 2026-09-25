import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRegistry, pickInitial, probeTarget } from "../src/registry.js";

const shipped = JSON.parse(readFileSync(new URL("../src/fleet.json", import.meta.url), "utf8"));

test("shipped fleet.json is valid and lists the five local surfaces", () => {
  const { surfaces, errors } = validateRegistry(shipped);
  assert.deepEqual(errors, []);
  assert.deepEqual(surfaces.map((s) => s.id), ["aceos", "hq", "utah", "sovereign", "estate"]);
  const byId = Object.fromEntries(surfaces.map((s) => [s.id, s]));
  assert.equal(byId.aceos.url, "http://127.0.0.1:8765");
  assert.equal(byId.hq.url, "http://127.0.0.1:8791");
  assert.equal(byId.utah.url, "http://127.0.0.1:8766");
  assert.equal(byId.estate.url, "http://127.0.0.1:8787");
  assert.equal(byId.sovereign.portFile, "~/.sovereign/dashboard.port");
  assert.equal(byId.sovereign.healthPath, "/api/health");
  assert.equal(byId.sovereign.expectOkJson, true);
});

test("every shipped surface says how to start it", () => {
  for (const s of shipped.surfaces) assert.ok(s.start && s.start.length > 20, `${s.id} has a start hint`);
});

test("AceOS is the default surface", () => {
  assert.equal(pickInitial(validateRegistry(shipped).surfaces).id, "aceos");
});

test("pickInitial falls back to the first surface, or null", () => {
  assert.equal(pickInitial([{ id: "a" }, { id: "b" }]).id, "a");
  assert.equal(pickInitial([]), null);
});

test("rejects a document without a surfaces array", () => {
  for (const raw of [null, 42, "x", {}, { surfaces: {} }]) {
    const r = validateRegistry(raw);
    assert.deepEqual(r.surfaces, []);
    assert.equal(r.errors.length, 1);
  }
});

const ok = { id: "x", name: "X", url: "http://127.0.0.1:9000" };

test("rejects bad entries with a reason and keeps the good ones", () => {
  const cases = [
    [{ ...ok, id: "Bad Id" }, /id must be/],
    [{ ...ok, name: " " }, /name is required/],
    [{ id: "x", name: "X" }, /exactly one of url or portFile/],
    [{ ...ok, portFile: "~/p" }, /exactly one of url or portFile/],
    [{ ...ok, url: "http://192.168.1.2:9000" }, /url must be http:\/\/ on 127\.0\.0\.1/],
    [{ ...ok, url: "https://127.0.0.1:9000" }, /url must be/],
    [{ ...ok, url: "http://127.0.0.1.evil.com" }, /url must be/],
    [{ id: "x", name: "X", portFile: "" }, /portFile must be a path/],
    [{ ...ok, healthPath: "api" }, /healthPath must start with \//],
    [{ ...ok, expectOkJson: true }, /expectOkJson needs a healthPath/],
    [{ ...ok, start: 5 }, /start must be text/],
    ["nope", /not an object/],
  ];
  for (const [bad, re] of cases) {
    const { surfaces, errors } = validateRegistry({ surfaces: [bad, { ...ok, id: "good" }] });
    assert.deepEqual(surfaces.map((s) => s.id), ["good"], JSON.stringify(bad));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^surface #1/);
    assert.match(errors[0], re);
  }
});

test("accepts localhost and [::1] URLs with paths", () => {
  const { errors } = validateRegistry({
    surfaces: [
      { ...ok, id: "a", url: "http://localhost:8080/dash" },
      { ...ok, id: "b", url: "http://[::1]:8080" },
    ],
  });
  assert.deepEqual(errors, []);
});

test("duplicate ids and multiple defaults are reported", () => {
  const { surfaces, errors } = validateRegistry({
    surfaces: [{ ...ok, default: true }, { ...ok, default: true }, { ...ok, id: "y", default: true }],
  });
  assert.deepEqual(surfaces.map((s) => s.id), ["x", "y"]);
  assert.match(errors[0], /duplicate id "x"/);
  assert.match(errors[1], /more than one surface is marked default/);
});

test("probeTarget maps a surface to the Rust command's shape", () => {
  assert.deepEqual(probeTarget(ok), {
    url: "http://127.0.0.1:9000", portFile: null, healthPath: null, expectOkJson: false, timeoutMs: 1500,
  });
  assert.deepEqual(probeTarget({ id: "s", name: "S", portFile: "~/p", healthPath: "/h", expectOkJson: true }, 900), {
    url: null, portFile: "~/p", healthPath: "/h", expectOkJson: true, timeoutMs: 900,
  });
});

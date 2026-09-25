import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOTION_KEY, REDUCE_QUERY, loadMotionPref, saveMotionPref, effectiveMotion, applyMotion, watchReduceMotion,
} from "../src/motion.js";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };

test("motion is off on a fresh profile", () => {
  assert.equal(loadMotionPref(memory()), false);
});

test("motion is off when storage is unavailable", () => {
  assert.equal(loadMotionPref(broken), false);
  assert.equal(loadMotionPref(undefined), false);
  assert.equal(saveMotionPref(broken, true), false);
});

test("the toggle persists", () => {
  const s = memory();
  assert.equal(saveMotionPref(s, true), true);
  assert.equal(s.m.get(MOTION_KEY), "true");
  assert.equal(loadMotionPref(s), true);
  saveMotionPref(s, false);
  assert.equal(loadMotionPref(s), false);
});

test("effective motion = enabled && !reduceMotion", () => {
  assert.equal(effectiveMotion(false, false), false);
  assert.equal(effectiveMotion(true, false), true);
  assert.equal(effectiveMotion(true, true), false);
  assert.equal(effectiveMotion(false, true), false);
});

test("applyMotion writes the gate attribute", () => {
  const root = { dataset: {} };
  assert.equal(applyMotion(root, true, false), true);
  assert.equal(root.dataset.motion, "on");
  assert.equal(applyMotion(root, true, true), false);
  assert.equal(root.dataset.motion, "off");
});

test("watchReduceMotion reads and follows the system setting", () => {
  let listener;
  const win = {
    matchMedia(q) {
      assert.equal(q, REDUCE_QUERY);
      return { matches: true, addEventListener: (ev, fn) => { assert.equal(ev, "change"); listener = fn; } };
    },
  };
  const seen = [];
  assert.equal(watchReduceMotion(win, (v) => seen.push(v)), true);
  listener({ matches: false });
  assert.deepEqual(seen, [false]);
  assert.equal(watchReduceMotion({}, () => {}), false);
});

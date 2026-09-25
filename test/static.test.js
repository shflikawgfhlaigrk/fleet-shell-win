// index.html and styles.css have no logic of their own; these tests pin the
// contract other files rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const html = read("../src/index.html");
const css = read("../src/styles.css");
const mainJs = read("../src/main.js");

test("index.html has every element main.js looks up", () => {
  const ids = new Set([...mainJs.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1]));
  for (const m of mainJs.matchAll(/for \(const id of \[([^\]]+)\]\)/g)) {
    for (const id of m[1].matchAll(/"([a-z-]+)"/g)) ids.add(id[1]);
  }
  assert.ok(ids.size >= 10, [...ids].join(","));
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `index.html is missing #${id}`);
});

test("index.html boots main.js as a module and ships static (motion off)", () => {
  assert.match(html, /<script type="module">[\s\S]*import \{ boot \} from "\.\/main\.js";/);
  assert.match(html, /<html lang="en" data-motion="off">/);
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
});

// FLEET-MOTION-STANDARD rule 3: every animation routes through the gate.
test("styles.css only animates behind :root[data-motion=\"on\"]", () => {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");
  const reduce = body.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\})\s*\}/);
  assert.ok(reduce, "has a prefers-reduced-motion block");
  assert.match(reduce[1], /animation: none !important/);
  assert.match(reduce[1], /transition: none !important/);
  const rest = body.replace(reduce[0], "");
  let moving = 0;
  for (const [, selector, decls] of rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/\b(animation|transition)(-[a-z-]+)?\s*:/.test(decls)) {
      moving++;
      for (const sel of selector.split(",")) {
        assert.match(sel.trim(), /^:root\[data-motion="on"\]/, `ungated motion in "${sel.trim()}"`);
      }
    }
  }
  assert.ok(moving >= 1, "the motion feature still exists (rule 2)");
});

test("styles.css styles every tone the shell emits", () => {
  for (const tone of ["up", "down", "warn", "error"]) {
    assert.match(css, new RegExp(`button\\[data-tone="${tone}"\\] \\.dot`));
  }
  for (const tone of ["down", "warn", "error"]) assert.match(css, new RegExp(`#panel\\[data-tone="${tone}"\\]`));
});

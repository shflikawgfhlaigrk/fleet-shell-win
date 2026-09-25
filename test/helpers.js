import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8")
  // The module script boots the real shell; tests build their own.
  .replace(/<script type="module">[\s\S]*?<\/script>/, "");

export function makeDom({ reduceMotion = false } = {}) {
  const dom = new JSDOM(html, { url: "http://localhost/" });
  const win = dom.window;
  const listeners = [];
  win.matchMedia = () => ({
    matches: reduceMotion,
    addEventListener: (_ev, fn) => listeners.push(fn),
  });
  win.setReduceMotion = (v) => listeners.forEach((fn) => fn({ matches: v }));
  return win;
}

export const text = (win, id) => win.document.getElementById(id).textContent;
export const tick = () => new Promise((r) => setTimeout(r, 0));

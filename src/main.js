// BlackLabel fleet shell: one window of chrome, every app surface is a URL.
// Surfaces come from fleet.json, bundled alongside this file. Before a surface
// is framed, the Rust side checks that its port answers; if it doesn't, the
// stage shows what failed, why, and what to do next instead of a blank frame.

import { validateRegistry, pickInitial } from "./registry.js";
import { probe, describe, where } from "./probe.js";
import { loadMotionPref, saveMotionPref, applyMotion, watchReduceMotion } from "./motion.js";

export function createShell({ doc, win, loadFleet, invoke, storage }) {
  const $ = (id) => doc.getElementById(id);
  const state = { surfaces: [], results: {}, active: null, token: 0, motion: false, reduce: false };

  function setStatus(text) {
    $("status").textContent = text;
  }

  function setMotion(enabled) {
    state.motion = enabled;
    applyMotion(doc.documentElement, state.motion, state.reduce);
    const toggle = $("motion-toggle");
    toggle.checked = enabled;
    toggle.title = state.reduce ? "System Reduce Motion is on, so motion stays off." : "";
  }

  function initMotion() {
    state.reduce = watchReduceMotion(win, (reduce) => {
      state.reduce = reduce;
      setMotion(state.motion);
    });
    setMotion(loadMotionPref(storage));
    $("motion-toggle").addEventListener("change", (e) => {
      saveMotionPref(storage, e.target.checked);
      setMotion(e.target.checked);
    });
  }

  function showPanel(surface, d, { retry = true } = {}) {
    const frame = $("surface");
    frame.style.display = "none";
    frame.removeAttribute("src");
    $("empty").style.display = "none";
    const panel = $("panel");
    panel.hidden = false;
    panel.dataset.tone = d.tone;
    panel.dataset.surface = surface ? surface.id : "";
    $("panel-title").textContent = surface ? `${surface.name}: ${d.label}` : d.label;
    $("panel-what-k").textContent = d.tone === "checking" ? "Status" : "What failed";
    $("panel-what").textContent = d.what;
    $("panel-why").textContent = d.why;
    $("panel-next").textContent = d.next;
    for (const id of ["panel-why", "panel-next"]) {
      $(id).closest(".row").hidden = !$(id).textContent;
    }
    $("panel-retry").hidden = !retry;
  }

  function showFrame(url) {
    $("panel").hidden = true;
    $("empty").style.display = "none";
    const frame = $("surface");
    frame.style.display = "block";
    frame.src = url;
  }

  function markTab(id) {
    const b = doc.querySelector(`#surfaces button[data-id="${id}"]`);
    if (!b) return;
    const d = describe(state.surfaces.find((s) => s.id === id), state.results[id]);
    b.dataset.tone = d.tone;
    b.title = d.label;
    b.querySelector(".dot").setAttribute("aria-label", d.label);
  }

  function renderTabs() {
    const nav = $("surfaces");
    nav.replaceChildren();
    for (const s of state.surfaces) {
      const b = doc.createElement("button");
      b.dataset.id = s.id;
      const dot = doc.createElement("span");
      dot.className = "dot";
      dot.setAttribute("role", "img");
      const label = doc.createElement("span");
      label.textContent = s.name;
      b.append(dot, label);
      b.addEventListener("click", () => activate(s.id));
      nav.appendChild(b);
      markTab(s.id);
    }
  }

  function renderRegistryErrors(errors) {
    const box = $("registry-errors");
    box.hidden = !errors.length;
    box.replaceChildren();
    if (!errors.length) return;
    const head = doc.createElement("strong");
    head.textContent = "Some fleet.json entries were skipped. Fix them in src/fleet.json and rebuild:";
    const list = doc.createElement("ul");
    for (const e of errors) {
      const li = doc.createElement("li");
      li.textContent = e;
      list.appendChild(li);
    }
    box.append(head, list);
  }

  async function check(id) {
    const s = state.surfaces.find((x) => x.id === id);
    delete state.results[id];
    markTab(id);
    const r = await probe(s, invoke);
    state.results[id] = r;
    markTab(id);
    return r;
  }

  async function activate(id) {
    const s = state.surfaces.find((x) => x.id === id);
    if (!s) return;
    const token = ++state.token;
    state.active = id;
    for (const b of doc.querySelectorAll("#surfaces button")) {
      b.classList.toggle("active", b.dataset.id === id);
      b.setAttribute("aria-pressed", b.dataset.id === id ? "true" : "false");
    }
    showPanel(s, describe(s, null), { retry: false });
    setStatus(`Checking ${where(s, null)}…`);
    const r = await check(id);
    if (token !== state.token) return; // user switched tabs meanwhile
    if (r.state === "up") {
      showFrame(r.url);
      setStatus(r.url);
    } else {
      const d = describe(s, r);
      showPanel(s, d);
      setStatus(`${s.name}: ${d.label}`);
    }
  }

  async function boot() {
    initMotion();
    $("panel-retry").addEventListener("click", () => {
      if (state.active) activate(state.active);
    });
    let raw;
    try {
      raw = await loadFleet();
    } catch (e) {
      showPanel(null, {
        tone: "error",
        label: "fleet.json could not be loaded",
        what: "The surface list (fleet.json) is missing or not valid JSON.",
        why: String(e && e.message ? e.message : e),
        next: "Restore src/fleet.json (see README.md for the format) and rebuild the shell.",
      }, { retry: false });
      setStatus("fleet.json missing or invalid");
      return;
    }
    const { surfaces, errors } = validateRegistry(raw);
    state.surfaces = surfaces;
    renderRegistryErrors(errors);
    renderTabs();
    const first = pickInitial(surfaces);
    if (!first) {
      $("panel").hidden = true;
      $("empty").style.display = "flex";
      setStatus("no surfaces");
      return;
    }
    // Probe the other tabs in the background so every dot shows real state.
    for (const s of surfaces) if (s.id !== first.id) check(s.id);
    await activate(first.id);
  }

  return { boot, activate, check, state };
}

export function boot(win = window) {
  const tauri = win.__TAURI__;
  const shell = createShell({
    doc: win.document,
    win,
    storage: win.localStorage,
    invoke: tauri && tauri.core ? tauri.core.invoke : undefined,
    loadFleet: async () => {
      const res = await win.fetch("fleet.json");
      if (!res.ok) throw new Error(`fleet.json: HTTP ${res.status}`);
      return res.json();
    },
  });
  return shell.boot().then(() => shell);
}

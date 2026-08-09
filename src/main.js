// BlackLabel fleet shell: one window of chrome, every app surface is a URL.
// Surfaces come from fleet.json, bundled alongside this file.

const state = { surfaces: [], active: null };

async function boot() {
  try {
    const res = await fetch("fleet.json");
    state.surfaces = (await res.json()).surfaces || [];
  } catch {
    setStatus("fleet.json missing or invalid");
    return;
  }
  renderTabs();
  const first = state.surfaces.find((s) => s.default) || state.surfaces[0];
  if (first) activate(first.id);
}

function renderTabs() {
  const nav = document.getElementById("surfaces");
  nav.replaceChildren();
  for (const s of state.surfaces) {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.dataset.id = s.id;
    b.addEventListener("click", () => activate(s.id));
    nav.appendChild(b);
  }
}

function activate(id) {
  const s = state.surfaces.find((x) => x.id === id);
  if (!s) return;
  state.active = id;
  for (const b of document.querySelectorAll("#surfaces button")) {
    b.classList.toggle("active", b.dataset.id === id);
  }
  document.getElementById("empty").style.display = "none";
  const frame = document.getElementById("surface");
  frame.style.display = "block";
  frame.src = s.url;
  setStatus(s.url);
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

boot();

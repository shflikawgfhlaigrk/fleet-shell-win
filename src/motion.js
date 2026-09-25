// Motion gate, per BlackLabel-Team CONTEXT/FLEET-MOTION-STANDARD-20260709.md:
//   1. off by default on a fresh profile
//   2. kept as a feature behind a visible toggle
//   3. every animation routes through the gate: styles.css only animates
//      under :root[data-motion="on"]
//   4. effective motion = enabled && !reduceMotion
//   5. the static look keeps its colours; only movement stops

export const MOTION_KEY = "fleet.motionEnabled";
export const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

export function loadMotionPref(storage) {
  try {
    return storage.getItem(MOTION_KEY) === "true";
  } catch {
    return false; // storage blocked or absent: stay static
  }
}

export function saveMotionPref(storage, enabled) {
  try {
    storage.setItem(MOTION_KEY, enabled ? "true" : "false");
    return true;
  } catch {
    return false;
  }
}

export function effectiveMotion(enabled, reduceMotion) {
  return !!enabled && !reduceMotion;
}

export function applyMotion(root, enabled, reduceMotion) {
  const on = effectiveMotion(enabled, reduceMotion);
  root.dataset.motion = on ? "on" : "off";
  return on;
}

// Reads the system Reduce Motion setting and calls back when it changes.
// Returns the current value.
export function watchReduceMotion(win, onChange) {
  if (!win || typeof win.matchMedia !== "function") return false;
  const mq = win.matchMedia(REDUCE_QUERY);
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", (e) => onChange(e.matches));
  }
  return mq.matches;
}

// Turns a surface into a probe call and a probe result into what the user
// reads: what failed, why, and what to do next. Every outcome, including ones
// this file doesn't recognise, produces all three lines.

import { probeTarget } from "./registry.js";

export async function probe(surface, invoke) {
  if (typeof invoke !== "function") {
    return {
      state: "error",
      reason: "ipc-missing",
      detail: "The Tauri bridge (window.__TAURI__) is not available; the page is running outside the shell.",
      url: surface.url ?? null,
      httpStatus: null,
    };
  }
  try {
    return await invoke("probe_surface", { target: probeTarget(surface) });
  } catch (e) {
    return {
      state: "error",
      reason: "ipc-failed",
      detail: String(e && e.message ? e.message : e),
      url: surface.url ?? null,
      httpStatus: null,
    };
  }
}

const LABEL = {
  checking: "Checking…",
  up: "Running",
  down: "Not running",
  wrongService: "Something else is on this port",
  blocked: "Can't be shown inside the shell",
  error: "Error",
  invalid: "Misconfigured",
};

const TONE = {
  checking: "checking",
  up: "up",
  down: "down",
  wrongService: "warn",
  blocked: "warn",
  error: "error",
  invalid: "error",
};

export function where(surface, result) {
  return (result && result.url) || surface.url || surface.portFile || surface.id;
}

// Returns { tone, label, what, why, next }. Never returns empty lines.
export function describe(surface, result) {
  const name = surface.name;
  const at = where(surface, result);
  const start = surface.start || `Start ${name}, then press Retry.`;
  const edit = "Fix this entry in src/fleet.json and rebuild the shell.";
  if (!result) {
    return { tone: TONE.checking, label: LABEL.checking, what: `Checking ${at}.`, why: "", next: "" };
  }
  const state = LABEL[result.state] ? result.state : "error";
  const out = (what, why, next) => ({ tone: TONE[state], label: LABEL[state], what, why, next });
  const d = result.detail || "(no detail)";

  switch (result.reason) {
    case "ok":
      return out(`${name} is answering at ${at}.`, d, "");
    case "refused":
      return out(
        `${name} is not running: nothing is listening at ${at}.`,
        "The connection was refused, so no program is serving that port.",
        start,
      );
    case "timeout":
      return out(
        `${name} did not answer at ${at} in time.`,
        `The connection attempt timed out (${d}). The service may be starting, hung, or blocked by a firewall.`,
        `Wait a moment and press Retry. If it keeps timing out, restart it. ${start}`,
      );
    case "port-file-missing":
      return out(
        `${name} is not running: its port file ${d} does not exist.`,
        `${name} writes the port it bound to that file when it starts, so a missing file means it isn't running on this machine.`,
        start,
      );
    case "port-file-invalid":
    case "port-file-unreadable":
      return out(
        `${name}'s port file can't be used.`,
        d,
        `Restart ${name} so it rewrites the file, then press Retry.`,
      );
    case "http-426":
      return out(
        `A WebSocket server is on ${at}, not ${name}.`,
        `${d}. Another program holds this port.${surface.portNote ? " " + surface.portNote : ""}`,
        `Stop the other program or move ${name} to a free port (and update src/fleet.json), then press Retry.`,
      );
    case "no-response":
    case "not-http":
      return out(
        `Something on ${at} is not ${name}.`,
        `${d}.${surface.portNote ? " " + surface.portNote : ""}`,
        `Find what holds the port (\`ss -ltnp\` on Linux, \`netstat -ano\` on Windows), stop it, then start ${name}.`,
      );
    case "health-not-ok":
      return out(
        `The program on ${at} did not identify itself as ${name}.`,
        d,
        `Another service may hold ${name}'s port. Restart ${name}, then press Retry.`,
      );
    case "http-5xx":
      return out(`${name} is running but failing at ${at}.`, d, `Check ${name}'s logs, then press Retry.`);
    case "http-status":
      return out(`${name} answered at ${at} with an error.`, d, `Check that ${name} serves this address, then press Retry.`);
    case "frame-denied":
    case "frame-ancestors":
      return out(
        `${name} is running but refuses to be shown inside another app.`,
        `It sends ${d}, so the shell's embedded frame would stay blank.`,
        `Open ${at} in a browser, or relax that header for loopback requests in ${name}.`,
      );
    case "not-loopback":
    case "bad-url":
    case "bad-target":
    case "port-file-path":
      return out(`The ${name} entry can't be probed.`, d, edit);
    case "ipc-missing":
    case "ipc-failed":
    case "probe-crashed":
    case "io-error":
    case "connect-failed":
      return out(
        `The shell could not check ${name}.`,
        d,
        "Press Retry. If it keeps failing, restart the shell and report the detail above.",
      );
    default:
      return out(
        `Unrecognised check result for ${name} (${result.state}/${result.reason}).`,
        d,
        "Press Retry. If it persists, report this message; the shell needs updating for this result.",
      );
  }
}

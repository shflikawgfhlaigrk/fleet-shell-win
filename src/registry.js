// Surface registry: validates fleet.json so a bad entry is reported, never
// silently dropped or silently loaded.

const ID = /^[a-z0-9][a-z0-9-]*$/;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i;

// Returns { surfaces, errors }. `surfaces` holds only usable entries;
// every rejected entry produces one human-readable line in `errors`.
export function validateRegistry(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.surfaces)) {
    return { surfaces: [], errors: ['fleet.json must be an object with a "surfaces" array.'] };
  }
  const seen = new Set();
  const surfaces = [];
  raw.surfaces.forEach((s, i) => {
    const where = `surface #${i + 1}${s && s.id ? ` ("${s.id}")` : ""}`;
    const problems = entryProblems(s);
    if (!problems.length && seen.has(s.id)) problems.push(`duplicate id "${s.id}"`);
    if (problems.length) {
      errors.push(`${where}: ${problems.join("; ")}`);
      return;
    }
    seen.add(s.id);
    surfaces.push(s);
  });
  if (surfaces.filter((s) => s.default).length > 1) {
    errors.push("more than one surface is marked default; the first one is used.");
  }
  return { surfaces, errors };
}

function entryProblems(s) {
  if (!s || typeof s !== "object") return ["not an object"];
  const p = [];
  if (typeof s.id !== "string" || !ID.test(s.id)) p.push("id must be lowercase letters, digits and dashes");
  if (typeof s.name !== "string" || !s.name.trim()) p.push("name is required");
  const hasUrl = s.url !== undefined;
  const hasPortFile = s.portFile !== undefined;
  if (hasUrl === hasPortFile) p.push("set exactly one of url or portFile");
  if (hasUrl && (typeof s.url !== "string" || !LOOPBACK_URL.test(s.url))) {
    p.push(`url must be http:// on 127.0.0.1, localhost or [::1] (got ${JSON.stringify(s.url)})`);
  }
  if (hasPortFile && (typeof s.portFile !== "string" || !s.portFile.trim())) p.push("portFile must be a path");
  if (s.healthPath !== undefined && (typeof s.healthPath !== "string" || !s.healthPath.startsWith("/"))) {
    p.push("healthPath must start with /");
  }
  if (s.expectOkJson && s.healthPath === undefined) p.push("expectOkJson needs a healthPath");
  for (const key of ["start", "notes", "portNote"]) {
    if (s[key] !== undefined && typeof s[key] !== "string") p.push(`${key} must be text`);
  }
  return p;
}

export function pickInitial(surfaces) {
  return surfaces.find((s) => s.default) || surfaces[0] || null;
}

// What the Rust probe command receives for a surface.
export function probeTarget(surface, timeoutMs = 1500) {
  return {
    url: surface.url ?? null,
    portFile: surface.portFile ?? null,
    healthPath: surface.healthPath ?? null,
    expectOkJson: !!surface.expectOkJson,
    timeoutMs,
  };
}

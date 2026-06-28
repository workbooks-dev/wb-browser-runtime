// Verb-argument substitution: {{ env.X }} / {{ artifacts.X }} expansion plus a
// `\{{` escape for literal template braces. Extracted from the entry point so
// it's unit-testable without booting the sidecar.
//
//   {{ env.NAME }}        → process.env.NAME
//   {{ artifacts.NAME }}  → contents of $WB_ARTIFACTS_DIR/NAME.txt (or .../NAME)
//   \{{                   → literal "{{" (escape; braces are NOT re-scanned)
//
// `expand(value, collected, artifactCache)` walks strings/arrays/objects.
// Resolved secret-ish values (≥3 chars) are added to `collected` so the caller
// can scrub them out of error messages with `scrubSecrets`.

import { readFileSync } from "node:fs";
import { log } from "./io.js";
import { resolveInside } from "./util.js";

// One combined pattern, scanned left-to-right in a single pass so the escape
// branch consumes the braces before either substitution branch can see them.
// Alternation order matters: the escape must come first.
//   \{{                   → no capture group (escape)
//   {{ env.NAME }}        → group 1
//   {{ artifacts.NAME }}  → group 2
// Artifact names are bare identifiers — no dots, no slashes — so a name can't
// compose with WB_ARTIFACTS_DIR into a path-traversal read.
const SUBST_RE =
  /\\\{\{|\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\{\{\s*artifacts\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g;

let warnedInvalidPolicy = false;

// Resolve the missing-value policy fresh each call (cheap) so the behavior
// tracks the current env. `warn` matches historical behavior (log + empty
// string, runbook continues). `error` throws so a missing OTP fails the slice
// instead of silently sending an empty value into a Playwright action. `empty`
// is the silent variant.
function resolveOnMissing() {
  const raw = (process.env.WB_SUBSTITUTION_ON_MISSING || "warn").trim().toLowerCase();
  if (raw === "error" || raw === "empty" || raw === "warn") return raw;
  if (!warnedInvalidPolicy) {
    warnedInvalidPolicy = true;
    log(
      `[warn] WB_SUBSTITUTION_ON_MISSING=${raw} is not valid (warn|error|empty); defaulting to warn`,
    );
  }
  return "warn";
}

function handleMissingSubstitution(kind, name) {
  const msg = `${kind}.${name} is not set`;
  if (resolveOnMissing() === "error") {
    throw new Error(`substitution: ${msg}`);
  }
  if (resolveOnMissing() === "warn") {
    log(`[warn] ${msg}; substituting empty string`);
  }
  return "";
}

function readArtifactRaw(name) {
  const dir = (process.env.WB_ARTIFACTS_DIR || "").trim();
  if (!dir) {
    log(`[warn] artifacts.${name} referenced but WB_ARTIFACTS_DIR is not set`);
    return null;
  }
  for (const candidate of [`${name}.txt`, name]) {
    const full = resolveInside(dir, candidate);
    if (!full) continue;
    try {
      return readFileSync(full, "utf8").trimEnd();
    } catch {
      // try next candidate
    }
  }
  return null;
}

function readArtifact(name, cache) {
  if (cache && cache.has(name)) {
    const hit = cache.get(name);
    if (hit === null) return handleMissingSubstitution("artifacts", name);
    return hit;
  }
  const v = readArtifactRaw(name);
  if (cache) cache.set(name, v);
  if (v === null) return handleMissingSubstitution("artifacts", name);
  return v;
}

export function expand(value, collected, artifactCache) {
  if (typeof value === "string") {
    return value.replace(SUBST_RE, (m, envName, artName) => {
      // Escape branch: `\{{` → literal `{{`. No capture group, so both
      // envName and artName are undefined here.
      if (envName === undefined && artName === undefined) return "{{";
      if (envName !== undefined) {
        const v = process.env[envName];
        if (v === undefined) return handleMissingSubstitution("env", envName);
        if (collected && v.length >= 3) collected.add(v);
        return v;
      }
      const v = readArtifact(artName, artifactCache);
      if (collected && v && v.length >= 3) collected.add(v);
      return v;
    });
  }
  if (Array.isArray(value))
    return value.map((v) => expand(v, collected, artifactCache));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = expand(v, collected, artifactCache);
    return out;
  }
  return value;
}

// Scrub any values that came from {{ env.X }} / {{ artifacts.X }} expansion out
// of error messages before they cross the stdio boundary — Playwright and fetch
// errors sometimes echo their inputs (URLs, script bodies, assertion text) and
// those inputs may contain credentials.
export function scrubSecrets(msg, secrets) {
  let out = String(msg == null ? "" : msg);
  if (!secrets) return out;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("«***»");
  }
  return out;
}

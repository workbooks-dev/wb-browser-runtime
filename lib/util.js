import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// Resolve `candidate` inside `dir`, rejecting traversal and absolute paths.
// Returns null when the resolved path escapes `dir` (or is `dir` itself).
// Used by the screenshot verb and substitution artifact reads — anywhere
// runbook-author-controlled strings could compose with a trusted directory
// into an arbitrary filesystem write.
export function resolveInside(dir, candidate) {
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(resolvedDir, candidate);
  const rel = path.relative(resolvedDir, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

// Collision-safe path inside `dir`. Returns the first path of the form
// `<base><ext>`, `<base>-2<ext>`, `<base>-3<ext>`, ... that doesn't already
// exist on disk. Playwright's `download.saveAs(path)` blindly overwrites,
// so this is the only thing standing between two same-named downloads
// (e.g. two `report.pdf` saves in one session) silently clobbering each
// other. Returns null if `name` would resolve outside `dir`.
//
// The check is racy (two concurrent downloads with the same suggestedName
// can both observe the same free slot before either writes) — acceptable
// here because downloads in a single session serialize through the same
// page in practice, and a stray collision would just produce one
// overwritten file rather than corrupting state.
export function uniquePathInside(dir, name) {
  const safe = sanitizeArtifactName(name);
  const first = resolveInside(dir, safe);
  if (!first) return null;
  if (!existsSync(first)) return first;
  const ext = path.extname(safe);
  const base = ext ? safe.slice(0, -ext.length) : safe;
  for (let n = 2; n < 1000; n++) {
    const candidate = resolveInside(dir, `${base}-${n}${ext}`);
    if (!candidate) return null;
    if (!existsSync(candidate)) return candidate;
  }
  // Fallback: append a random suffix. 1000 collisions on the same name in
  // one session is unrealistic, but we'd rather degrade than throw.
  const rand = randomUUID().slice(0, 8);
  return resolveInside(dir, `${base}-${rand}${ext}`);
}

// Parse a comma-separated extension allowlist from raw env (e.g.
// "pdf, xlsx,CSV"). Returns a Set of lowercase extensions without leading
// dots, or null when the input is empty/unset (callers treat null as "no
// filter — capture everything").
export function parseExtensionAllowlist(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s
    .split(",")
    .map((x) => x.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return new Set(parts);
}

// Match a filename against an extension allowlist. `null` allowlist means
// no filter (anything passes). Files with no extension never pass a
// non-null allowlist — the caller wanted a specific set, an unknown blob
// isn't it.
export function extensionAllowed(filename, allowlist) {
  if (!allowlist) return true;
  const ext = path.extname(String(filename || "")).toLowerCase().replace(/^\./, "");
  if (!ext) return false;
  return allowlist.has(ext);
}

export function sanitizeArtifactName(s) {
  // Keep author-chosen names readable but safe as filenames. Drop anything
  // that could escape the artifacts dir (slashes, NULs, etc.).
  return String(s).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 200);
}

export function autoArtifactName(blockIndex) {
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  const n = Number.isFinite(blockIndex) ? blockIndex : 0;
  return `cell-${n}-${rand}`;
}

export function redact(value) {
  if (typeof value !== "string") return "";
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***`;
}

// Tests for download-capture helpers and the listener's filter +
// dispatch logic. The Playwright integration path (real `download` events)
// is covered by manual smoke testing; here we exercise the bits that don't
// need a real browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  uniquePathInside,
  parseExtensionAllowlist,
  extensionAllowed,
} from "../lib/util.js";

// --- parseExtensionAllowlist -----------------------------------------------

test("parseExtensionAllowlist returns null for unset/empty input", () => {
  assert.equal(parseExtensionAllowlist(undefined), null);
  assert.equal(parseExtensionAllowlist(null), null);
  assert.equal(parseExtensionAllowlist(""), null);
  assert.equal(parseExtensionAllowlist("   "), null);
  assert.equal(parseExtensionAllowlist(",,,"), null);
});

test("parseExtensionAllowlist normalizes case, dots, and whitespace", () => {
  const a = parseExtensionAllowlist(" PDF, .xlsx ,Csv,.DOCX ");
  assert.deepEqual([...a].sort(), ["csv", "docx", "pdf", "xlsx"]);
});

test("parseExtensionAllowlist accepts a single value", () => {
  const a = parseExtensionAllowlist("pdf");
  assert.deepEqual([...a], ["pdf"]);
});

// --- extensionAllowed -------------------------------------------------------

test("extensionAllowed returns true when allowlist is null (no filter)", () => {
  assert.equal(extensionAllowed("anything.xyz", null), true);
  assert.equal(extensionAllowed("noext", null), true);
  assert.equal(extensionAllowed("", null), true);
});

test("extensionAllowed matches case-insensitively against the allowlist", () => {
  const a = parseExtensionAllowlist("pdf,xlsx");
  assert.equal(extensionAllowed("report.PDF", a), true);
  assert.equal(extensionAllowed("data.xlsx", a), true);
  assert.equal(extensionAllowed("notes.txt", a), false);
});

test("extensionAllowed rejects files with no extension when allowlist is set", () => {
  const a = parseExtensionAllowlist("pdf");
  assert.equal(extensionAllowed("noext", a), false);
  assert.equal(extensionAllowed("", a), false);
});

test("extensionAllowed handles multi-dot filenames (uses last segment)", () => {
  const a = parseExtensionAllowlist("gz");
  assert.equal(extensionAllowed("archive.tar.gz", a), true);
  assert.equal(extensionAllowed("archive.tar.xz", a), false);
});

// --- uniquePathInside -------------------------------------------------------

function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), "wb-dlcap-"));
  return d;
}

test("uniquePathInside returns the bare path when no collision", () => {
  const dir = tmp();
  try {
    const got = uniquePathInside(dir, "report.pdf");
    assert.equal(got, path.join(dir, "report.pdf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePathInside suffixes -2, -3 on collision", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "report.pdf"), "");
    const second = uniquePathInside(dir, "report.pdf");
    assert.equal(second, path.join(dir, "report-2.pdf"));

    writeFileSync(second, "");
    const third = uniquePathInside(dir, "report.pdf");
    assert.equal(third, path.join(dir, "report-3.pdf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePathInside preserves the extension on suffixed names", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "data.tar.gz"), "");
    const got = uniquePathInside(dir, "data.tar.gz");
    assert.equal(path.basename(got), "data.tar-2.gz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePathInside handles names with no extension", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "blob"), "");
    const got = uniquePathInside(dir, "blob");
    assert.equal(path.basename(got), "blob-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePathInside never lets a traversal-shaped name escape dir", () => {
  // Contract: either return null (refuse to save) or a path inside `dir`.
  // sanitizeArtifactName collapses slashes/punctuation, but conservatively
  // we still null-out anything that resolveInside flags (e.g. names that
  // post-sanitization start with literal `..`). Both outcomes are safe.
  const dir = tmp();
  try {
    for (const bad of ["../escape.pdf", "/etc/passwd", "../../../../tmp/x"]) {
      const got = uniquePathInside(dir, bad);
      if (got !== null) {
        assert.ok(
          got.startsWith(dir + path.sep),
          `${bad} resolved to ${got}, must be inside ${dir}`,
        );
        assert.equal(path.dirname(got), dir);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniquePathInside sanitizes runbook-author-controlled names", () => {
  const dir = tmp();
  try {
    // Slashes get replaced by sanitizeArtifactName before traversal check;
    // result must still land inside `dir`.
    const got = uniquePathInside(dir, "weird/name with spaces.pdf");
    assert.ok(got);
    assert.ok(got.startsWith(dir + path.sep));
    assert.match(path.basename(got), /\.pdf$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- installDownloadCapture: filter + skip frame ---------------------------

test("installDownloadCapture installs a context listener and skips on extension mismatch", async () => {
  const { installDownloadCapture, HANDLED_MARK } = await import(
    "../lib/download-capture.js"
  );

  // Capture frames written by `send` (which calls process.stdout.write).
  const original = process.stdout.write.bind(process.stdout);
  const frames = [];
  process.stdout.write = (chunk, ...rest) => {
    try {
      const line = String(chunk).trim();
      if (line.startsWith("{")) frames.push(JSON.parse(line));
    } catch {}
    return original(chunk, ...rest);
  };

  const dir = tmp();
  const prevDir = process.env.WB_ARTIFACTS_DIR;
  const prevExt = process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;
  process.env.WB_ARTIFACTS_DIR = dir;
  process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS = "pdf,xlsx";

  // Minimal context double — only `on()` matters for installDownloadCapture.
  let registered;
  const fakeContext = {
    on(event, handler) {
      if (event === "download") registered = handler;
    },
  };

  try {
    installDownloadCapture(fakeContext, () => ({
      index: 3,
      name: "click",
    }));
    assert.equal(typeof registered, "function");

    // Simulate a download event for a non-allowlisted file.
    let cancelled = false;
    const fakeDownload = {
      suggestedFilename: () => "tracker.png",
      url: () => "https://example.com/tracker.png",
      page: () => ({ url: () => "https://example.com/" }),
      cancel: async () => {
        cancelled = true;
      },
    };
    registered(fakeDownload);

    // Listener returns synchronously but the work is async — wait one tick.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cancelled, true, "skipped download should be cancelled");
    const skipped = frames.find((f) => f.type === "slice.download_skipped");
    assert.ok(skipped, "expected slice.download_skipped frame");
    assert.equal(skipped.suggested_filename, "tracker.png");
    assert.equal(skipped.verb_index, 3);
    assert.equal(skipped.verb_name, "click");

    // No file should have been written.
    assert.equal(existsSync(path.join(dir, "tracker.png")), false);
    // Make sure we didn't accidentally emit an artifact_saved frame.
    assert.equal(
      frames.some((f) => f.type === "slice.artifact_saved"),
      false,
    );
    // Ensure the HANDLED_MARK export exists for the future explicit verb.
    assert.equal(typeof HANDLED_MARK, "symbol");
  } finally {
    process.stdout.write = original;
    if (prevDir === undefined) delete process.env.WB_ARTIFACTS_DIR;
    else process.env.WB_ARTIFACTS_DIR = prevDir;
    if (prevExt === undefined) delete process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;
    else process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS = prevExt;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installDownloadCapture saves matching downloads and emits artifact_saved", async () => {
  const { installDownloadCapture } = await import(
    "../lib/download-capture.js"
  );

  const original = process.stdout.write.bind(process.stdout);
  const frames = [];
  process.stdout.write = (chunk, ...rest) => {
    try {
      const line = String(chunk).trim();
      if (line.startsWith("{")) frames.push(JSON.parse(line));
    } catch {}
    return original(chunk, ...rest);
  };

  const dir = tmp();
  const prevDir = process.env.WB_ARTIFACTS_DIR;
  const prevExt = process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;
  process.env.WB_ARTIFACTS_DIR = dir;
  delete process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;

  let registered;
  const fakeContext = {
    on(event, handler) {
      if (event === "download") registered = handler;
    },
  };

  try {
    installDownloadCapture(fakeContext, () => ({ index: 1, name: "click" }));

    const fakeDownload = {
      suggestedFilename: () => "report.pdf",
      url: () => "https://example.com/report.pdf",
      page: () => ({ url: () => "https://example.com/" }),
      saveAs: async (target) => {
        writeFileSync(target, "hello-pdf");
      },
    };
    registered(fakeDownload);
    // Wait a couple of ticks for the async chain to settle.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const target = path.join(dir, "report.pdf");
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target, "utf8"), "hello-pdf");

    const saved = frames.find((f) => f.type === "slice.artifact_saved");
    assert.ok(saved, "expected slice.artifact_saved frame");
    assert.equal(saved.filename, "report.pdf");
    assert.equal(saved.path, target);
    assert.equal(saved.bytes, "hello-pdf".length);
    assert.equal(saved.source, "download");
    assert.equal(saved.provenance.verb_index, 1);
    assert.equal(saved.provenance.verb_name, "click");
    assert.equal(saved.provenance.url, "https://example.com/report.pdf");
    assert.equal(saved.provenance.page_url, "https://example.com/");
  } finally {
    process.stdout.write = original;
    if (prevDir === undefined) delete process.env.WB_ARTIFACTS_DIR;
    else process.env.WB_ARTIFACTS_DIR = prevDir;
    if (prevExt === undefined) delete process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;
    else process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS = prevExt;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installDownloadCapture is a no-op when WB_ARTIFACTS_DIR is unset", async () => {
  const { installDownloadCapture } = await import(
    "../lib/download-capture.js"
  );
  const prev = process.env.WB_ARTIFACTS_DIR;
  delete process.env.WB_ARTIFACTS_DIR;
  let registered = false;
  const fakeContext = {
    on() {
      registered = true;
    },
  };
  try {
    installDownloadCapture(fakeContext, () => null);
    assert.equal(registered, false, "should not attach listener without artifacts dir");
  } finally {
    if (prev === undefined) delete process.env.WB_ARTIFACTS_DIR;
    else process.env.WB_ARTIFACTS_DIR = prev;
  }
});

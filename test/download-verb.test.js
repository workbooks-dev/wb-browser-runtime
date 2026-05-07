// Tests for the `download` verb. The verb installs a page-side capture
// hook, races `page.waitForEvent("download")` against an in-page blob
// poll, and writes the captured file into $WB_ARTIFACTS_DIR. We exercise
// each path with a hand-rolled stub Page (the shared stub-page lacks
// waitForEvent / context, both of which the verb needs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

import { VERB_REGISTRY } from "../verbs/index.js";
import { captureSendFrames } from "../lib/stub-page.js";
import { HANDLED_MARK } from "../lib/download-capture.js";

// Deferred for stubbing waitForEvent: tests resolve/reject manually so the
// race against the click and the blob poll is fully observable.
function deferred() {
  const out = {};
  out.promise = new Promise((res, rej) => {
    out.resolve = res;
    out.reject = rej;
  });
  return out;
}

// Build a stub Page wired for the download verb. `opts` configures each
// async behavior. The stub records calls so tests can assert on what the
// verb invoked and in which order.
function makePage(opts = {}) {
  const calls = [];
  const ctxListeners = { download: [] };
  const browserContext = {
    on(event, fn) {
      (ctxListeners[event] ??= []).push(fn);
    },
    prependListener(event, fn) {
      (ctxListeners[event] ??= []).unshift(fn);
    },
    off(event, fn) {
      const arr = ctxListeners[event] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    _listeners: ctxListeners,
  };
  const page = {
    calls,
    _ctx: browserContext,
    url() {
      return opts.url ?? "https://example.com/dashboard";
    },
    context() {
      return browserContext;
    },
    async evaluate(script) {
      calls.push({ verb: "evaluate", script });
      // First evaluate is the PAGE_HOOK install; subsequent ones are the
      // blob poll. Tests can override either via opts.evaluateImpl.
      if (typeof opts.evaluateImpl === "function") {
        return opts.evaluateImpl(script, calls);
      }
      return null;
    },
    async click(selector, options) {
      calls.push({ verb: "click", selector, options });
      if (opts.clickImpl) return opts.clickImpl(selector, options);
    },
    waitForEvent(event, options) {
      calls.push({ verb: "waitForEvent", event, options });
      if (opts.waitForEventImpl) return opts.waitForEventImpl(event, options);
      return new Promise(() => {}); // pend forever by default
    },
    getByText(text, options) {
      calls.push({ verb: "getByText", text, options });
      return {
        first() {
          return {
            async click(o) {
              calls.push({ verb: "fallback.click", text, options: o });
              if (opts.fallbackClickImpl) return opts.fallbackClickImpl(o);
            },
          };
        },
      };
    },
  };
  return { page, browserContext, ctxListeners };
}

async function withArtifactsDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "wb-dl-verb-"));
  const prev = process.env.WB_ARTIFACTS_DIR;
  process.env.WB_ARTIFACTS_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.WB_ARTIFACTS_DIR;
    else process.env.WB_ARTIFACTS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// --- 1. Normal Playwright download event -----------------------------------

test("download saves a real Playwright Download into WB_ARTIFACTS_DIR", async (t) => {
  const dir = await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const wfe = deferred();
  let savedAtPath = null;
  const fakeDownload = {
    suggestedFilename: () => "report.xlsx",
    url: () => "https://example.com/report.xlsx",
    page: () => ({ url: () => "https://example.com/dashboard" }),
    async saveAs(target) {
      savedAtPath = target;
      // Mimic Playwright streaming bytes to the target path.
      const fs = await import("node:fs/promises");
      await fs.writeFile(target, "xlsx-bytes");
    },
    async cancel() {},
  };

  const { page, ctxListeners } = makePage({
    waitForEventImpl: () => wfe.promise,
  });

  // Drive the verb concurrently so we can fire the "download" event mid-flight.
  const verbPromise = VERB_REGISTRY.download.execute(
    page,
    { selector: "button.download", path: "pilot-profit-loss.xlsx" },
    { index: 4 },
  );

  // Let the verb register listeners and start the click + waitForEvent.
  await new Promise((r) => setImmediate(r));

  // Simulate the BrowserContext firing the download event. The verb's
  // claim listener should have been prepended, so it runs first.
  for (const l of ctxListeners.download) l(fakeDownload);
  // After listeners run, HANDLED_MARK should be set so the passive
  // listener (in real life) would skip.
  assert.equal(fakeDownload[HANDLED_MARK], true);

  // Resolve waitForEvent with the same Download object — that's the
  // signal the verb is actually waiting on.
  wfe.resolve(fakeDownload);

  const summary = await verbPromise;

  assert.equal(summary, "→ pilot-profit-loss.xlsx");
  // saveAs honored the explicit path:.
  assert.equal(savedAtPath, path.join(dir, "pilot-profit-loss.xlsx"));
  assert.equal(existsSync(savedAtPath), true);
  assert.equal(statSync(savedAtPath).size, "xlsx-bytes".length);

  const saved = cap.frames.find((f) => f.type === "slice.artifact_saved");
  assert.ok(saved, "expected slice.artifact_saved frame");
  assert.equal(saved.filename, "pilot-profit-loss.xlsx");
  assert.equal(saved.path, savedAtPath);
  assert.equal(saved.bytes, "xlsx-bytes".length);
  assert.equal(saved.source, "download");
  assert.equal(saved.provenance.verb_index, 4);
  assert.equal(saved.provenance.verb_name, "download");
  assert.equal(saved.provenance.url, "https://example.com/report.xlsx");
  assert.equal(saved.provenance.suggested_filename, "pilot-profit-loss.xlsx");

  // Click happened, hook was injected.
  assert.ok(page.calls.find((c) => c.verb === "click" && c.selector === "button.download"));
  assert.ok(page.calls.find((c) => c.verb === "evaluate"));
});

test("download falls back to the suggested filename when path: omitted", async (t) => {
  const dir = await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const wfe = deferred();
  const fakeDownload = {
    suggestedFilename: () => "statement-2026-04.pdf",
    url: () => "https://example.com/dl",
    async saveAs(target) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(target, "pdf");
    },
    async cancel() {},
  };

  const { page, ctxListeners } = makePage({
    waitForEventImpl: () => wfe.promise,
  });

  const verbPromise = VERB_REGISTRY.download.execute(
    page,
    { selector: "button.download" },
    { index: 0 },
  );

  await new Promise((r) => setImmediate(r));
  for (const l of ctxListeners.download) l(fakeDownload);
  wfe.resolve(fakeDownload);

  const summary = await verbPromise;
  assert.equal(summary, "→ statement-2026-04.pdf");
  assert.equal(existsSync(path.join(dir, "statement-2026-04.pdf")), true);
});

// --- 2. App-generated Blob download ----------------------------------------

test("download captures an in-page Blob when Playwright misses the event", async (t) => {
  const dir = await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  // Playwright's waitForEvent never fires (e.g. the SPA uses
  // window.location = blobUrl which doesn't trip the download event).
  // Instead the page hook captures the blob and stashes base64 bytes on
  // window.__wbDownload. The verb's poll should pick it up.
  const wfe = deferred(); // resolved with TimeoutError below
  const blobBytes = Buffer.from("hello-blob-bytes");
  let evalCallCount = 0;
  const evaluateImpl = (script) => {
    evalCallCount++;
    // First eval is the PAGE_HOOK install; tests can ignore the script
    // contents — we just need to return null so the install no-ops, then
    // serve the blob payload on the very next poll.
    if (evalCallCount === 1) return null; // install
    return {
      filename: "in-page.bin",
      bytes: blobBytes.toString("base64"),
      mimeType: "application/octet-stream",
    };
  };

  const { page } = makePage({
    waitForEventImpl: () => wfe.promise,
    evaluateImpl,
  });

  const verbPromise = VERB_REGISTRY.download.execute(
    page,
    { selector: "button.download", path: "captured.bin", timeout: 1000 },
    { index: 2 },
  );

  // Eventually the verb's blob poll fires and wins the race. Resolve
  // waitForEvent with a fake timeout error after we've already won, so
  // the verb's other branch is observable as "playwright_failed" in
  // diagnostics if it ever gets there. (It shouldn't, but the reject is
  // here so the promise doesn't hang and leak.)
  setTimeout(() => {
    const err = new Error("Timeout 1000ms exceeded.");
    err.name = "TimeoutError";
    wfe.reject(err);
  }, 5);

  const summary = await verbPromise;
  assert.equal(summary, "→ captured.bin");

  const target = path.join(dir, "captured.bin");
  assert.equal(existsSync(target), true);
  const onDisk = await readFile(target);
  assert.equal(onDisk.toString(), "hello-blob-bytes");

  const saved = cap.frames.find((f) => f.type === "slice.artifact_saved");
  assert.ok(saved);
  assert.equal(saved.source, "download");
  assert.equal(saved.provenance.capture, "blob");
  assert.equal(saved.provenance.mime_type, "application/octet-stream");
  assert.equal(saved.bytes, blobBytes.length);
});

// --- 3. Timeout with diagnostics -------------------------------------------

test("download throws diagnostic error when no file is captured before timeout", async (t) => {
  await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  // waitForEvent rejects with TimeoutError immediately. The blob poll
  // returns null forever. Result: both paths fail and the verb throws
  // with a structured message + emits a slice.download_failed frame.
  const { page } = makePage({
    waitForEventImpl: async () => {
      const err = new Error("Timeout 100ms exceeded waiting for event \"download\"");
      err.name = "TimeoutError";
      throw err;
    },
    evaluateImpl: () => null,
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        { selector: "button.download", timeout: 100 },
        { index: 7 },
      ),
    (e) => {
      assert.match(e.message, /download: no file captured within 100ms/);
      assert.match(e.message, /button\.download/);
      assert.match(e.message, /page=https:\/\/example\.com\/dashboard/);
      assert.match(e.message, /playwright download:/);
      assert.match(e.message, /blob hook: no capture within 100ms/);
      return true;
    },
  );

  const failed = cap.frames.find((f) => f.type === "slice.download_failed");
  assert.ok(failed, "expected slice.download_failed diagnostics frame");
  assert.equal(failed.verb, "download");
  assert.equal(failed.verb_index, 7);
  assert.equal(failed.selector, "button.download");
  assert.equal(failed.timeout_ms, 100);
  assert.equal(failed.page_url, "https://example.com/dashboard");
  assert.match(failed.reason, /playwright download/);
});

// --- 4. Argument validation -------------------------------------------------

test("download throws when WB_ARTIFACTS_DIR is unset", async (t) => {
  const prev = process.env.WB_ARTIFACTS_DIR;
  delete process.env.WB_ARTIFACTS_DIR;
  t.after(() => {
    if (prev !== undefined) process.env.WB_ARTIFACTS_DIR = prev;
  });
  const { page } = makePage();
  await assert.rejects(
    () => VERB_REGISTRY.download.execute(page, { selector: "x" }, { index: 0 }),
    /WB_ARTIFACTS_DIR is not set/,
  );
});

test("download throws when selector is missing", async (t) => {
  await withArtifactsDir(t);
  const { page } = makePage();
  await assert.rejects(
    () => VERB_REGISTRY.download.execute(page, {}, { index: 0 }),
    /`selector` is required/,
  );
});

test("download rejects extension not in WB_BROWSER_DOWNLOAD_EXTENSIONS allowlist", async (t) => {
  await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);
  const prevExt = process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;
  process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS = "pdf";
  t.after(() => {
    if (prevExt === undefined) delete process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS;
    else process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS = prevExt;
  });

  const wfe = deferred();
  let cancelled = false;
  const fakeDownload = {
    suggestedFilename: () => "tracker.png",
    url: () => "https://x/tracker.png",
    async saveAs() {
      throw new Error("should not save — extension was rejected");
    },
    async cancel() {
      cancelled = true;
    },
  };

  const { page, ctxListeners } = makePage({
    waitForEventImpl: () => wfe.promise,
  });

  const verbPromise = VERB_REGISTRY.download.execute(
    page,
    { selector: "a", path: "tracker.png" },
    { index: 0 },
  );
  await new Promise((r) => setImmediate(r));
  for (const l of ctxListeners.download) l(fakeDownload);
  wfe.resolve(fakeDownload);

  await assert.rejects(verbPromise, /rejected by WB_BROWSER_DOWNLOAD_EXTENSIONS/);
  assert.equal(cancelled, true, "rejected download should be cancelled");
});

test("download surfaces click failure over generic 'no file captured' message", async (t) => {
  await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const clickErr = Object.assign(new Error("click failed: detached frame"), {
    name: "Error",
  });
  const { page } = makePage({
    waitForEventImpl: async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    },
    evaluateImpl: () => null,
    clickImpl: async () => {
      throw clickErr;
    },
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        { selector: "button.broken", timeout: 100 },
        { index: 0 },
      ),
    (e) => e === clickErr,
  );
});

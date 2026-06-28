// Tests for the `download` verb. The verb installs a page-side capture
// hook, races `page.waitForEvent("download")` against an in-page blob
// poll, and writes the captured file into $WB_ARTIFACTS_DIR. We exercise
// each path with a hand-rolled stub Page (the shared stub-page lacks
// waitForEvent / context, both of which the verb needs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
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

// --- 5. Signed-URL export capture ------------------------------------------

// Stub globalThis.fetch (retryableFetch uses the global) and record the URL it
// was called with so we can assert the sidecar fetched the FULL signed URL.
function stubFetch(t, impl) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  t.after(() => {
    globalThis.fetch = prev;
  });
  return calls;
}

// Set an env var for the duration of a test, restoring the prior value after.
function withEnv(t, key, value) {
  const prev = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

// The SSRF guard resolves hostnames via DNS and rejects private IPs. These
// stubbed-fetch tests target a public-looking S3 host but never make a real
// request, so allow private IPs to avoid a real DNS lookup of a fake host.
function allowPrivateDownloadIp(t) {
  withEnv(t, "WB_ALLOW_PRIVATE_DOWNLOAD_IP", "1");
}

// evaluateImpl that serves one signed candidate on the first SIGNED_POLL and
// nothing on the blob poll. Distinguishes install vs poll by script content.
function signedEvaluateImpl(candidate) {
  let served = false;
  return (script) => {
    if (script.includes("Installed")) return null; // hook installs
    if (script.includes("__wbSignedCandidates")) {
      if (served) return [];
      served = true;
      return [candidate];
    }
    if (script.includes("__wbDownload")) return null; // blob poll: nothing
    return null;
  };
}

test("download captures a signed export URL and fetches it server-side", async (t) => {
  const dir = await withArtifactsDir(t);
  allowPrivateDownloadIp(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const signedUrl = "https://bucket.s3.amazonaws.com/reports/pl.xlsx?X-Amz-Signature=deadbeef";
  const fetchCalls = stubFetch(t, async () =>
    new Response(Buffer.from("xlsx-from-s3"), {
      status: 200,
      headers: { "content-type": "application/vnd.ms-excel" },
    }),
  );

  // Playwright download never fires; the blob hook sees nothing. Only the
  // signed-URL JSON response is observed.
  const { page } = makePage({
    waitForEventImpl: () => new Promise(() => {}),
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app.example.com/reports/1/download",
      urls: [{ field: "download_url", url: signedUrl }],
    }),
  });

  const summary = await VERB_REGISTRY.download.execute(
    page,
    { selector: "button.export", path: "pl.xlsx", timeout: 2000 },
    { index: 3 },
  );

  assert.equal(summary, "→ pl.xlsx");
  const target = path.join(dir, "pl.xlsx");
  assert.equal(existsSync(target), true);
  assert.equal((await readFile(target)).toString(), "xlsx-from-s3");

  // Sidecar fetched the FULL signed URL (credentials intact for the GET).
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, signedUrl);

  const saved = cap.frames.find((f) => f.type === "slice.artifact_saved");
  assert.ok(saved, "expected slice.artifact_saved");
  assert.equal(saved.provenance.capture, "signed_url");
  assert.equal(saved.provenance.field, "download_url");
  assert.equal(saved.provenance.api_url, "https://app.example.com/reports/1/download");
  assert.equal(saved.provenance.content_type, "application/vnd.ms-excel");
  // The signed URL is redacted everywhere it crosses the boundary.
  assert.equal(
    saved.provenance.signed_url,
    "https://bucket.s3.amazonaws.com/reports/pl.xlsx?<redacted>",
  );
  assert.equal(saved.provenance.url, null);
});

test("download emits download_failed with expired:true on a 403 signed URL", async (t) => {
  await withArtifactsDir(t);
  allowPrivateDownloadIp(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const signedUrl = "https://bucket.s3.amazonaws.com/reports/pl.xlsx?X-Amz-Signature=stale";
  stubFetch(t, async () => new Response("AccessDenied", { status: 403 }));

  const { page } = makePage({
    waitForEventImpl: () => new Promise(() => {}),
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app.example.com/reports/1/download",
      urls: [{ field: "download_url", url: signedUrl }],
    }),
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        { selector: "button.export", path: "pl.xlsx", timeout: 2000 },
        { index: 0 },
      ),
    /HTTP 403.*expired/,
  );

  const failed = cap.frames.find((f) => f.type === "slice.download_failed");
  assert.ok(failed, "expected slice.download_failed");
  assert.equal(failed.capture, "signed_url");
  assert.equal(failed.http_status, 403);
  assert.equal(failed.expired, true);
  assert.equal(failed.signed_url, "https://bucket.s3.amazonaws.com/reports/pl.xlsx?<redacted>");
});

// Spin up a throwaway loopback HTTP server for SSRF / size-cap tests.
function startServer(t, handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      t.after(() => new Promise((r) => server.close(r)));
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

// --- 6. SSRF guard: redirects + private IPs --------------------------------

test("download rejects a signed URL that redirects to a disallowed host (SSRF)", async (t) => {
  const dir = await withArtifactsDir(t);
  // Permit the 127.0.0.1 origin itself; the redirect target host is the gate.
  allowPrivateDownloadIp(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  let hits = 0;
  const { port, base } = await startServer(t, (req, res) => {
    hits++;
    res.statusCode = 302;
    // Redirect to a host that is neither a recognized signed host nor in the
    // allowlist — the guard must refuse to follow it.
    res.setHeader("Location", "http://blocked.example.invalid/secret.bin");
    res.end();
  });

  const signedUrl = `${base}/start.bin`;
  const { page } = makePage({
    waitForEventImpl: () => new Promise(() => {}),
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app.example.com/d",
      urls: [{ field: "download_url", url: signedUrl }],
    }),
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        {
          selector: "button.export",
          path: "out.bin",
          timeout: 2000,
          signed_url: { enabled: true, hosts: [`127.0.0.1:${port}`] },
        },
        { index: 0 },
      ),
    /host not allowed/,
  );

  assert.equal(hits, 1, "only the initial URL should be fetched, never the redirect");
  assert.equal(existsSync(path.join(dir, "out.bin")), false, "no file should be written");
  const failed = cap.frames.find((f) => f.type === "slice.download_failed");
  assert.ok(failed, "expected slice.download_failed");
  assert.match(failed.reason, /host not allowed/);
});

test("download rejects a signed URL host that is a private/loopback IP (SSRF)", async (t) => {
  const dir = await withArtifactsDir(t);
  // Deliberately do NOT allow private IPs.
  const cap = captureSendFrames();
  t.after(cap.dispose);

  // Prove no network request is ever made — the guard rejects before fetch.
  let fetched = false;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("guard should have blocked before any fetch");
  };
  t.after(() => {
    globalThis.fetch = prevFetch;
  });

  const signedUrl = "http://127.0.0.1:9/secret.bin"; // loopback literal
  const { page } = makePage({
    waitForEventImpl: () => new Promise(() => {}),
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app.example.com/d",
      urls: [{ field: "download_url", url: signedUrl }],
    }),
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        {
          selector: "button.export",
          path: "out.bin",
          timeout: 2000,
          signed_url: { enabled: true, hosts: ["127.0.0.1:9"] },
        },
        { index: 0 },
      ),
    /private\/loopback IP/,
  );

  assert.equal(fetched, false, "guard must reject before any network fetch");
  assert.equal(existsSync(path.join(dir, "out.bin")), false);
  const failed = cap.frames.find((f) => f.type === "slice.download_failed");
  assert.ok(failed);
  assert.match(failed.reason, /private\/loopback IP/);
});

// --- 7. Size cap ------------------------------------------------------------

test("download rejects a signed URL whose Content-Length exceeds the cap", async (t) => {
  const dir = await withArtifactsDir(t);
  allowPrivateDownloadIp(t);
  withEnv(t, "WB_MAX_DOWNLOAD_BYTES", "16");
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const big = Buffer.alloc(1024, 0x41);
  const { port, base } = await startServer(t, (req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", String(big.length));
    res.end(big);
  });

  const signedUrl = `${base}/big.bin`;
  const { page } = makePage({
    waitForEventImpl: () => new Promise(() => {}),
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app/d",
      urls: [{ field: "download_url", url: signedUrl }],
    }),
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        {
          selector: "button.export",
          path: "big.bin",
          timeout: 2000,
          signed_url: { enabled: true, hosts: [`127.0.0.1:${port}`] },
        },
        { index: 0 },
      ),
    /exceeds size cap/,
  );

  assert.equal(existsSync(path.join(dir, "big.bin")), false, "oversized file must not be written");
  const failed = cap.frames.find((f) => f.type === "slice.download_failed");
  assert.ok(failed);
  assert.match(failed.reason, /Content-Length .* cap/);
});

test("download aborts a signed URL whose streamed body exceeds the cap (no Content-Length)", async (t) => {
  const dir = await withArtifactsDir(t);
  allowPrivateDownloadIp(t);
  withEnv(t, "WB_MAX_DOWNLOAD_BYTES", "16");
  const cap = captureSendFrames();
  t.after(cap.dispose);

  // Chunked response (no Content-Length) that dribbles far more than the cap,
  // so the Content-Length pre-check can't catch it — only the streaming guard.
  const { base, port } = await startServer(t, (req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    const chunk = Buffer.alloc(64, 0x42);
    let n = 0;
    const iv = setInterval(() => {
      if (n++ >= 8) {
        clearInterval(iv);
        try {
          res.end();
        } catch {}
        return;
      }
      try {
        res.write(chunk);
      } catch {
        clearInterval(iv);
      }
    }, 5);
  });

  const signedUrl = `${base}/stream.bin`;
  const { page } = makePage({
    waitForEventImpl: () => new Promise(() => {}),
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app/d",
      urls: [{ field: "download_url", url: signedUrl }],
    }),
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        {
          selector: "button.export",
          path: "stream.bin",
          timeout: 2000,
          signed_url: { enabled: true, hosts: [`127.0.0.1:${port}`] },
        },
        { index: 0 },
      ),
    /size cap/,
  );

  assert.equal(
    existsSync(path.join(dir, "stream.bin")),
    false,
    "partial over-cap file must be removed",
  );
  const failed = cap.frames.find((f) => f.type === "slice.download_failed");
  assert.ok(failed);
  assert.match(failed.reason, /mid-stream/);
});

// --- 8. Forced-mode requires a host match (no bypass) ----------------------

test("download (forced signed_url) without a host match captures nothing", async (t) => {
  const dir = await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  // Forced mode + json_fields, but the URL host is neither signed nor in any
  // allowlist. The picker must NOT select it, so the verb times out with no
  // capture (and never reaches the server-side fetch).
  let fetched = false;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error("should not fetch — no host match");
  };
  t.after(() => {
    globalThis.fetch = prevFetch;
  });

  const { page } = makePage({
    waitForEventImpl: async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    },
    evaluateImpl: signedEvaluateImpl({
      api_url: "https://app.example.com/d",
      urls: [{ field: "download_url", url: "https://app.example.com/x.csv?tok=9" }],
    }),
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        {
          selector: "button.export",
          path: "x.csv",
          timeout: 150,
          signed_url: { enabled: true, json_fields: ["download_url"] },
        },
        { index: 0 },
      ),
    /no file captured/,
  );

  assert.equal(fetched, false, "no server-side fetch without a host match");
  assert.equal(existsSync(path.join(dir, "x.csv")), false);
});

test("download with signed_url:false does not install the signed hook", async (t) => {
  await withArtifactsDir(t);
  const cap = captureSendFrames();
  t.after(cap.dispose);

  const scripts = [];
  const { page } = makePage({
    waitForEventImpl: async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    },
    evaluateImpl: (script) => {
      scripts.push(script);
      return null;
    },
  });

  await assert.rejects(
    () =>
      VERB_REGISTRY.download.execute(
        page,
        { selector: "button.export", signed_url: false, timeout: 100 },
        { index: 0 },
      ),
    /no file captured/,
  );

  // No signed hook install and no signed poll happened.
  assert.equal(
    scripts.some((s) => s.includes("__wbSignedInstalled")),
    false,
    "signed hook should not be installed when signed_url:false",
  );
  assert.equal(
    scripts.some((s) => s.includes("__wbSignedCandidates")),
    false,
    "signed poll should not run when signed_url:false",
  );
});

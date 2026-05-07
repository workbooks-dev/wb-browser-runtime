// download — explicit "click and capture" verb.
//
// The passive listener in lib/download-capture.js already saves any file the
// browser downloads, but it has no say over the filename and announces a
// `slice.artifact_saved` frame asynchronously after `saveAs` resolves. Some
// runbooks want stronger guarantees:
//   - "the file lands at exactly $WB_ARTIFACTS_DIR/<path>"
//   - "if it doesn't appear within ~10s, fail the slice with diagnostics"
//   - works for SPAs that build the file in-page via fetch/XHR + Blob and
//     don't always trip Playwright's `download` event reliably
//
// This verb installs capture hooks BEFORE clicking, races
// `page.waitForEvent("download")` against an in-page blob/anchor capture
// hook, and either saves the bytes itself (blob path) or hands the
// Playwright Download to `saveAs` (download path). Whichever path wins,
// the verb sets HANDLED_MARK on the Download (when applicable) so the
// passive listener doesn't double-save.

import path from "node:path";
import { Buffer } from "node:buffer";
import { promises as fsPromises } from "node:fs";
import { send } from "../lib/io.js";
import {
  uniquePathInside,
  parseExtensionAllowlist,
  extensionAllowed,
} from "../lib/util.js";
import { HANDLED_MARK } from "../lib/download-capture.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const FALLBACK_NAME = "download.bin";

// Page-side hook that traps blob/data-URL anchor clicks the SPA performs
// programmatically — `URL.createObjectURL(blob)` + `<a download>` + `.click()`.
// Playwright's own `download` event normally catches these, but a handful
// of SPAs trigger downloads via `window.open(blobUrl)` or
// `window.location = blobUrl` which slip past. The hook re-fetches the blob
// in-page, base64-encodes the bytes, and stashes them on
// `window.__wbDownload` for the Node side to poll.
//
// Idempotent: re-installing on each verb invocation is a no-op after the
// first. We never uninstall — leaves the page in a slightly altered state
// but the wrapped click is functionally equivalent to the original.
const PAGE_HOOK = `(() => {
  if (window.__wbDownloadInstalled) return;
  window.__wbDownloadInstalled = true;
  window.__wbDownload = null;

  const captureBlob = async (target, filename, mime) => {
    try {
      let blob;
      if (typeof target === "string") {
        const resp = await fetch(target);
        blob = await resp.blob();
      } else {
        blob = target;
      }
      const buf = await blob.arrayBuffer();
      const bin = new Uint8Array(buf);
      let s = "";
      for (let i = 0; i < bin.length; i++) s += String.fromCharCode(bin[i]);
      window.__wbDownload = {
        filename: filename || "download.bin",
        bytes: btoa(s),
        mimeType: mime || blob.type || "application/octet-stream",
      };
    } catch (e) {
      window.__wbDownload = { error: String((e && e.message) || e) };
    }
  };

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const href = this.getAttribute("href") || this.href || "";
      const hasDownload = this.hasAttribute("download");
      if (hasDownload && (href.startsWith("blob:") || href.startsWith("data:"))) {
        const fname = this.getAttribute("download") || this.download || "";
        captureBlob(href, fname);
      }
    } catch {}
    return origClick.apply(this, arguments);
  };
})()`;

// Read-and-clear of `window.__wbDownload`. Returning the value AND nulling
// it lets the page hook capture multiple downloads across separate verb
// calls without leaking state from a prior call into the next poll.
const POLL_SCRIPT = `(() => {
  const v = window.__wbDownload;
  window.__wbDownload = null;
  return v;
})()`;

export default {
  name: "download",
  primaryKey: "selector",
  async execute(page, args, ctx) {
    const artifactsDir = (process.env.WB_ARTIFACTS_DIR || "").trim();
    if (!artifactsDir) {
      throw new Error(
        "download: $WB_ARTIFACTS_DIR is not set — run this workbook via `wb run` (wb exports the dir for you)",
      );
    }
    if (!args.selector) {
      throw new Error("download: `selector` is required");
    }
    const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS;
    const explicitPath =
      typeof args.path === "string" && args.path.trim()
        ? args.path.trim()
        : null;
    const allowlist = parseExtensionAllowlist(
      process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS,
    );

    // 1) Inject the page-side blob/anchor capture hook BEFORE the click so a
    //    synchronously-dispatched anchor.click() inside the SPA's handler is
    //    observed. Best-effort: a frame mid-navigation can reject evaluate;
    //    the Playwright `download` event still works and is the primary
    //    signal anyway.
    try {
      await page.evaluate(PAGE_HOOK);
    } catch {}

    // 2) Claim ownership of the next download synchronously — prepended to
    //    BrowserContext listeners so it runs before lib/download-capture.js's
    //    passive listener has a chance to start its async capture chain. The
    //    HANDLED_MARK tells the passive listener to bail.
    const claim = (download) => {
      try {
        download[HANDLED_MARK] = true;
      } catch {}
    };
    const browserContext = safeContext(page);
    let attached = false;
    if (browserContext) {
      if (typeof browserContext.prependListener === "function") {
        browserContext.prependListener("download", claim);
        attached = true;
      } else if (typeof browserContext.on === "function") {
        // Fallback: append. Race window is tiny (passive listener checks
        // HANDLED_MARK before its first await), but ordering isn't
        // guaranteed without prependListener.
        browserContext.on("download", claim);
        attached = true;
      }
    }

    try {
      // 3) Race the two capture sources against the click. The download event
      //    AND the click run concurrently — Playwright's standard pattern,
      //    since the click can resolve before or after the download fires.
      const downloadPromise = page
        .waitForEvent("download", { timeout })
        .then((d) => ({ kind: "playwright", download: d }))
        .catch((e) => ({ kind: "playwright_failed", error: e }));

      const blobPromise = pollForBlob(page, timeout);

      let clickError = null;
      const clickPromise = (async () => {
        try {
          await page.click(args.selector, { timeout });
        } catch (err) {
          const isTimeout = err && err.name === "TimeoutError";
          if (isTimeout && args.text_fallback) {
            try {
              await page
                .getByText(args.text_fallback, { exact: false })
                .first()
                .click({ timeout });
              return;
            } catch {
              clickError = err;
              return;
            }
          }
          clickError = err;
        }
      })();

      const winner = await raceCaptures(downloadPromise, blobPromise);
      // Wait for the click to settle so we surface its error (if any) over
      // a generic "no file captured" — a click that never landed is the
      // more actionable failure.
      await clickPromise;
      if (clickError) throw clickError;

      if (winner.success && winner.kind === "playwright") {
        return await savePlaywrightDownload({
          download: winner.download,
          artifactsDir,
          allowlist,
          explicitPath,
          page,
          ctx,
        });
      }
      if (winner.success && winner.kind === "blob") {
        return await saveBlobDownload({
          blob: winner.blob,
          artifactsDir,
          allowlist,
          explicitPath,
          page,
          ctx,
        });
      }

      // No capture won — emit structured failure diagnostics.
      const reasons = winner.failures
        .map((f) => {
          if (f.kind === "playwright_failed") {
            return `playwright download: ${f.error?.message || f.error}`;
          }
          if (f.kind === "blob_failed") return `blob hook: ${f.error}`;
          if (f.kind === "blob_timeout") return `blob hook: no capture within ${timeout}ms`;
          return f.kind;
        })
        .join("; ");
      send({
        type: "slice.download_failed",
        verb: "download",
        verb_index: ctx?.index ?? null,
        selector: args.selector,
        timeout_ms: timeout,
        page_url: safePageUrl(page),
        reason: reasons,
      });
      throw new Error(
        `download: no file captured within ${timeout}ms after clicking ${args.selector} (page=${safePageUrl(page) || "?"}). ${reasons}`,
      );
    } finally {
      if (attached && browserContext && typeof browserContext.off === "function") {
        try {
          browserContext.off("download", claim);
        } catch {}
      }
    }
  },
};

async function savePlaywrightDownload({
  download,
  artifactsDir,
  allowlist,
  explicitPath,
  page,
  ctx,
}) {
  const suggested = explicitPath || safeSuggestedFilename(download);
  const sourceUrl = safeUrl(download);
  if (!extensionAllowed(suggested, allowlist)) {
    try {
      await download.cancel();
    } catch {}
    throw new Error(
      `download: file "${suggested}" rejected by WB_BROWSER_DOWNLOAD_EXTENSIONS`,
    );
  }
  const target = uniquePathInside(artifactsDir, suggested);
  if (!target) {
    throw new Error(
      `download: refusing to save "${suggested}" — resolves outside $WB_ARTIFACTS_DIR`,
    );
  }
  await fsPromises.mkdir(artifactsDir, { recursive: true });
  await download.saveAs(target);
  let bytes = null;
  try {
    bytes = (await fsPromises.stat(target)).size;
  } catch {}
  send({
    type: "slice.artifact_saved",
    filename: path.basename(target),
    path: target,
    bytes,
    source: "download",
    provenance: {
      url: sourceUrl,
      suggested_filename: suggested,
      page_url: safePageUrl(page),
      verb_index: ctx?.index ?? null,
      verb_name: "download",
      ts: Date.now(),
    },
  });
  return `→ ${path.basename(target)}`;
}

async function saveBlobDownload({
  blob,
  artifactsDir,
  allowlist,
  explicitPath,
  page,
  ctx,
}) {
  const suggested = explicitPath || blob.filename || FALLBACK_NAME;
  if (!extensionAllowed(suggested, allowlist)) {
    throw new Error(
      `download: file "${suggested}" rejected by WB_BROWSER_DOWNLOAD_EXTENSIONS`,
    );
  }
  const target = uniquePathInside(artifactsDir, suggested);
  if (!target) {
    throw new Error(
      `download: refusing to save "${suggested}" — resolves outside $WB_ARTIFACTS_DIR`,
    );
  }
  const buf = Buffer.from(blob.bytes, "base64");
  await fsPromises.mkdir(artifactsDir, { recursive: true });
  await fsPromises.writeFile(target, buf);
  send({
    type: "slice.artifact_saved",
    filename: path.basename(target),
    path: target,
    bytes: buf.length,
    source: "download",
    provenance: {
      url: null,
      suggested_filename: suggested,
      page_url: safePageUrl(page),
      verb_index: ctx?.index ?? null,
      verb_name: "download",
      mime_type: blob.mimeType || null,
      capture: "blob",
      ts: Date.now(),
    },
  });
  return `→ ${path.basename(target)}`;
}

// Race two capture promises. First to report success wins. Both must report
// before we declare failure, so the diagnostics frame can list every reason
// the verb didn't see a file. (Promise.race would shortcut on a fast failure
// and discard the slower success.)
function raceCaptures(downloadPromise, blobPromise) {
  return new Promise((resolve) => {
    let outstanding = 2;
    const failures = [];
    const finish = (settled) => {
      if (settled.success) {
        resolve(settled);
        return;
      }
      failures.push(settled);
      if (--outstanding === 0) resolve({ success: false, failures });
    };
    downloadPromise.then((r) => {
      if (r.kind === "playwright") finish({ success: true, ...r });
      else finish({ success: false, ...r });
    });
    blobPromise.then((r) => {
      if (r.kind === "blob") finish({ success: true, ...r });
      else finish({ success: false, ...r });
    });
  });
}

async function pollForBlob(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let result;
    try {
      result = await page.evaluate(POLL_SCRIPT);
    } catch {
      result = null;
    }
    if (result && result.bytes) return { kind: "blob", blob: result };
    if (result && result.error) return { kind: "blob_failed", error: result.error };
    if (Date.now() >= deadline) return { kind: "blob_timeout" };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function safePageUrl(page) {
  try {
    return page.url();
  } catch {
    return null;
  }
}

function safeContext(page) {
  try {
    return page.context();
  } catch {
    return null;
  }
}

function safeSuggestedFilename(download) {
  try {
    const s = download.suggestedFilename();
    return s && s.trim() ? s : FALLBACK_NAME;
  } catch {
    return FALLBACK_NAME;
  }
}

function safeUrl(download) {
  try {
    return download.url();
  } catch {
    return null;
  }
}

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
import { promises as fsPromises, createWriteStream } from "node:fs";
import { once } from "node:events";
import { send } from "../lib/io.js";
import {
  uniquePathInside,
  parseExtensionAllowlist,
  extensionAllowed,
} from "../lib/util.js";
import { HANDLED_MARK } from "../lib/download-capture.js";
import {
  guardedDownloadFetch,
  releaseBodyTimeout,
  abortBody,
  drainResponseBody,
} from "../lib/http.js";
import {
  SIGNED_PAGE_HOOK,
  SIGNED_POLL_SCRIPT,
  parseSignedConfig,
  pickSignedCandidate,
  redactSignedUrl,
  isSignedHost,
} from "../lib/signed-url-capture.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;
const FALLBACK_NAME = "download.bin";

// Hard cap on signed-URL download size to bound memory/disk. A lying or absent
// Content-Length can't bypass it: the stream is aborted once bytes exceed it.
// Override for tests/ops via WB_MAX_DOWNLOAD_BYTES.
const MAX_SIGNED_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MiB

function maxDownloadBytes() {
  const v = Number(process.env.WB_MAX_DOWNLOAD_BYTES);
  return Number.isFinite(v) && v > 0 ? v : MAX_SIGNED_DOWNLOAD_BYTES;
}

// Test/ops escape hatch: by default the SSRF guard rejects targets that resolve
// to private/loopback IPs. A local test server lives on 127.0.0.1, so the guard
// must be opt-out-able for those tests. Production leaves this unset.
function privateDownloadIpAllowed() {
  const v = String(process.env.WB_ALLOW_PRIVATE_DOWNLOAD_IP || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Build the host validator applied to the initial signed URL *and* every
// redirect hop — the same gate pickSignedCandidate uses, so a redirect can't
// escape to a host the picker would never have selected.
function makeSignedHostValidator(signedCfg) {
  const hosts = (signedCfg && signedCfg.hosts) || [];
  return (host) => {
    if (!host) return false;
    const h = String(host).toLowerCase();
    const hostAllowed =
      hosts.length > 0 && hosts.some((x) => h === x || h.endsWith(`.${x}`));
    return hostAllowed || isSignedHost(h);
  };
}

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
    const signedCfg = parseSignedConfig(args.signed_url);
    const signedEnabled = signedCfg.enabled !== false;

    // 1) Inject the page-side blob/anchor capture hook BEFORE the click so a
    //    synchronously-dispatched anchor.click() inside the SPA's handler is
    //    observed. Best-effort: a frame mid-navigation can reject evaluate;
    //    the Playwright `download` event still works and is the primary
    //    signal anyway. When signed-URL capture is enabled, install its
    //    fetch/XHR response hook in the same pre-click window so the API call
    //    the click triggers is observed from the start.
    try {
      await page.evaluate(PAGE_HOOK);
    } catch {}
    if (signedEnabled) {
      try {
        await page.evaluate(SIGNED_PAGE_HOOK);
      } catch {}
    }

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

    // Shared cancellation token: once the race has a winner, the losing
    // pollers stop on their next tick instead of spinning page.evaluate against
    // a (possibly navigating/closing) page for the rest of the timeout window.
    const stop = { done: false };

    try {
      // 3) Race the capture sources against the click. The download event AND
      //    the click run concurrently — Playwright's standard pattern, since
      //    the click can resolve before or after the download fires.
      const downloadPromise = page
        .waitForEvent("download", { timeout })
        .then((d) => ({ kind: "playwright", download: d }))
        .catch((e) => ({ kind: "playwright_failed", error: e }));

      const blobPromise = pollForBlob(page, timeout, stop);

      const signedPromise = signedEnabled
        ? pollForSignedUrl(page, timeout, signedCfg, stop)
        : null;

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

      const winner = await raceCaptures(
        [downloadPromise, blobPromise, signedPromise].filter(Boolean),
      );
      // Winner decided (success or all-failed) — release the losing pollers.
      stop.done = true;
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
      if (winner.success && winner.kind === "signed_url") {
        return await saveSignedUrlDownload({
          signed: winner.signed,
          artifactsDir,
          allowlist,
          explicitPath,
          page,
          ctx,
          timeout,
          signedCfg,
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
          if (f.kind === "signed_failed") return `signed url: ${f.error}`;
          if (f.kind === "signed_timeout")
            return `signed url: no signed file URL seen within ${timeout}ms`;
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
      // Backstop: ensure pollers are released on any exit path (thrown
      // click/save error, extension rejection, etc.).
      stop.done = true;
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

// Race N capture promises. First to report success wins. Every source must
// report before we declare failure, so the diagnostics frame can list every
// reason the verb didn't see a file. (Promise.race would shortcut on a fast
// failure and discard a slower success.) Each promise resolves to an object
// whose `kind` names the source: a success kind ("playwright" | "blob" |
// "signed_url") or a failure kind ("*_failed" | "*_timeout").
const SUCCESS_KINDS = new Set(["playwright", "blob", "signed_url"]);

function raceCaptures(promises) {
  return new Promise((resolve) => {
    let outstanding = promises.length;
    const failures = [];
    const finish = (settled) => {
      if (settled.success) {
        resolve(settled);
        return;
      }
      failures.push(settled);
      if (--outstanding === 0) resolve({ success: false, failures });
    };
    for (const pr of promises) {
      pr.then((r) => {
        if (SUCCESS_KINDS.has(r.kind)) finish({ success: true, ...r });
        else finish({ success: false, ...r });
      });
    }
  });
}

async function saveSignedUrlDownload({
  signed,
  artifactsDir,
  allowlist,
  explicitPath,
  page,
  ctx,
  timeout,
  signedCfg,
}) {
  const redacted = redactSignedUrl(signed.url);
  // Filename: explicit path: wins, else the signed URL's basename, else a
  // generic fallback. (S3 keys usually end in the real filename.)
  let nameFromUrl = "";
  try {
    nameFromUrl = path.basename(new URL(signed.url).pathname) || "";
  } catch {}
  const suggested = explicitPath || (nameFromUrl.trim() ? nameFromUrl : FALLBACK_NAME);
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
  await fsPromises.mkdir(artifactsDir, { recursive: true });

  const maxBytes = maxDownloadBytes();
  const failed = (extra, reason) =>
    send({
      type: "slice.download_failed",
      verb: "download",
      verb_index: ctx?.index ?? null,
      capture: "signed_url",
      api_url: signed.api_url,
      signed_url: redacted,
      page_url: safePageUrl(page),
      ...extra,
      reason,
    });

  // Fetch the signed URL from the sidecar (not the page) so the object store's
  // CORS policy doesn't block the read. Redirects are followed *manually* with
  // the same host allowlist + private-IP block applied to every hop (SSRF), and
  // the body-read timeout stays armed until we finish streaming. The label is
  // redacted — retry logs must never echo signed credentials.
  let res;
  try {
    res = await guardedDownloadFetch(signed.url, {
      timeoutMs: timeout,
      validateHost: makeSignedHostValidator(signedCfg),
      allowPrivateIp: privateDownloadIpAllowed(),
      label: `signed-url download (${redacted})`,
    });
  } catch (e) {
    failed({}, `signed url fetch error: ${e?.message || e}`);
    throw new Error(
      `download: signed URL fetch failed for ${redacted}: ${e?.message || e}`,
    );
  }

  try {
    if (!res.ok) {
      // A 403 on a pre-signed URL almost always means the token expired before
      // we fetched it — call that out so the operator knows to shorten the gap.
      const expired = res.status === 403;
      await drainResponseBody(res); // don't leak the socket
      failed(
        { http_status: res.status, expired },
        `signed url fetch: HTTP ${res.status}${expired ? " (likely expired)" : ""}`,
      );
      throw new Error(
        `download: signed URL fetch returned HTTP ${res.status} for ${redacted}${expired ? " (likely expired)" : ""}`,
      );
    }

    // Reject up front when the server *declares* an oversized body...
    const clRaw = safeHeader(res, "content-length");
    const cl = clRaw == null ? NaN : Number(clRaw);
    if (Number.isFinite(cl) && cl > maxBytes) {
      await drainResponseBody(res);
      failed(
        { content_length: cl, max_bytes: maxBytes },
        `signed url body too large: Content-Length ${cl} > cap ${maxBytes}`,
      );
      throw new Error(
        `download: signed URL body exceeds size cap (${cl} > ${maxBytes} bytes) for ${redacted}`,
      );
    }

    // ...and enforce while streaming so a lying/absent Content-Length can't slip
    // past. Streams to disk rather than materializing the whole body in memory.
    let bytes;
    try {
      bytes = await streamToFileWithCap(res, target, maxBytes);
    } catch (e) {
      if (e && e.code === "WB_SIZE_CAP") {
        failed(
          { max_bytes: maxBytes },
          `signed url body exceeded size cap of ${maxBytes} bytes mid-stream`,
        );
        throw new Error(
          `download: signed URL body exceeded size cap (${maxBytes} bytes) for ${redacted}`,
        );
      }
      failed({}, `signed url body read error: ${e?.message || e}`);
      throw new Error(
        `download: signed URL body read failed for ${redacted}: ${e?.message || e}`,
      );
    }

    const contentType = safeHeader(res, "content-type");
    const contentDisposition = safeHeader(res, "content-disposition");
    send({
      type: "slice.artifact_saved",
      filename: path.basename(target),
      path: target,
      bytes,
      source: "download",
      provenance: {
        url: null,
        signed_url: redacted,
        api_url: signed.api_url,
        field: signed.field,
        suggested_filename: suggested,
        page_url: safePageUrl(page),
        verb_index: ctx?.index ?? null,
        verb_name: "download",
        capture: "signed_url",
        content_type: contentType,
        content_disposition: contentDisposition,
        ts: Date.now(),
      },
    });
    return `→ ${path.basename(target)}`;
  } finally {
    // Body fully consumed (or we bailed) — disarm the body-read timeout.
    releaseBodyTimeout(res);
  }
}

// Stream a response body to disk, counting bytes and aborting the in-flight
// read once the cap is exceeded (so an absent/under-stated Content-Length can't
// OOM us). Removes the partial file on any error. Returns total bytes written.
async function streamToFileWithCap(res, target, maxBytes) {
  const reader = res.body?.getReader?.();
  const ws = createWriteStream(target);
  let total = 0;
  try {
    if (!reader) {
      // No body to read (e.g. 204) — write an empty file.
      await new Promise((resolve, reject) =>
        ws.end((e) => (e ? reject(e) : resolve())),
      );
      return 0;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        abortBody(res); // abort the underlying socket read
        try {
          await reader.cancel();
        } catch {}
        const err = new Error(`size cap exceeded`);
        err.code = "WB_SIZE_CAP";
        throw err;
      }
      if (!ws.write(Buffer.from(value))) {
        await once(ws, "drain");
      }
    }
    await new Promise((resolve, reject) =>
      ws.end((e) => (e ? reject(e) : resolve())),
    );
    return total;
  } catch (e) {
    // Await the stream's close before unlinking: createWriteStream opens its fd
    // asynchronously, so unlinking eagerly can race the (lazy) open and leave a
    // resurrected empty file behind.
    try {
      await new Promise((resolve) => {
        ws.once("close", resolve);
        ws.destroy();
      });
    } catch {}
    try {
      await fsPromises.unlink(target);
    } catch {}
    throw e;
  }
}

async function pollForBlob(page, timeoutMs, stop) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (stop?.done) return { kind: "blob_timeout" };
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

// Poll the page-side signed-URL candidate buffer until a candidate matching
// the configured policy appears or the deadline passes. The bytes are NOT
// fetched here — the winner is fetched server-side by saveSignedUrlDownload so
// CORS doesn't apply. Returns the picked candidate; never throws (page
// evaluate errors degrade to "keep polling").
async function pollForSignedUrl(page, timeoutMs, signedCfg, stop) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (stop?.done) return { kind: "signed_timeout" };
    let cands = null;
    try {
      cands = await page.evaluate(SIGNED_POLL_SCRIPT);
    } catch {
      cands = null;
    }
    if (Array.isArray(cands) && cands.length) {
      const picked = pickSignedCandidate(cands, signedCfg);
      if (picked) return { kind: "signed_url", signed: picked };
    }
    if (Date.now() >= deadline) return { kind: "signed_timeout" };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function safeHeader(res, name) {
  try {
    return res.headers?.get?.(name) || null;
  } catch {
    return null;
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

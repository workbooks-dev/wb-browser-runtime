// download-capture — passive capture of any file the browser downloads
// during a session, regardless of which verb (or page redirect, or popup)
// triggered it.
//
// The runbook author doesn't have to predict downloads. We attach a
// `download` listener to the BrowserContext at session start; every file
// the browser saves lands in `$WB_ARTIFACTS_DIR` and gets announced via a
// `slice.artifact_saved` frame so wb's existing R2 uploader picks it up
// for free. Provenance (page URL, source URL, which verb was running, ts)
// rides along on the frame so the run-page event feed can show *why* a
// given file appeared.
//
// Filtering: if WB_BROWSER_DOWNLOAD_EXTENSIONS is set, only files whose
// extension matches the allowlist are kept. Skipped downloads still get a
// `slice.download_skipped` frame so the operator sees what was discarded
// (rare in practice — `download` events fire on real attachments, not
// inline analytics pings — but useful when a SPA emits noisy JSON blobs).
//
// Big files: there is no size cap. R2 is bottomless and the runbook's own
// timeout governs hung downloads — `download.saveAs()` only resolves once
// bytes are fully streamed, so a stuck download will trip the cell deadline
// and surface as a normal cell failure.
//
// Cloud vs local: `download.saveAs(absPath)` works for both. Playwright
// streams the bytes back over CDP for cloud-attached browsers, so the file
// always lands on the sidecar machine where $WB_ARTIFACTS_DIR lives.

import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { send, log, logWarn } from "./io.js";
import {
  uniquePathInside,
  parseExtensionAllowlist,
  extensionAllowed,
} from "./util.js";

// Marker that the explicit (future) `download:` gating verb sets on a
// Download object once it's claimed it. The passive listener checks for
// this and skips, so the same file isn't saved twice.
export const HANDLED_MARK = Symbol.for("wb.download.handled");

// Sentinel filename used when Playwright reports an empty suggestedFilename
// (rare, but theoretically possible for downloads with no Content-
// Disposition header and an empty URL path).
const FALLBACK_NAME = "download.bin";

// Install the always-on download listener on `context`. Returns a no-op
// when WB_ARTIFACTS_DIR isn't set — without an artifacts dir there's
// nowhere to put the file, and bailing here is preferable to inventing a
// temp dir that wb's uploader doesn't watch.
//
// `getCurrentVerb()` is a callback the entry point updates each iteration
// of the slice loop, so the listener can attach `verb_index` / `verb_name`
// to the announcement without the slice loop having to reach back into
// this module.
export function installDownloadCapture(context, getCurrentVerb) {
  const artifactsDir = (process.env.WB_ARTIFACTS_DIR || "").trim();
  if (!artifactsDir) {
    log("[download-capture] WB_ARTIFACTS_DIR not set; auto-capture disabled");
    return;
  }
  const allowlist = parseExtensionAllowlist(
    process.env.WB_BROWSER_DOWNLOAD_EXTENSIONS,
  );
  if (allowlist) {
    log(
      `[download-capture] enabled; extension allowlist: ${[...allowlist].join(",")}`,
    );
  } else {
    log("[download-capture] enabled; capturing all downloads");
  }

  context.on("download", (download) => {
    captureOne({ download, artifactsDir, allowlist, getCurrentVerb }).catch(
      (e) => {
        // Never let a failed capture take down the slice — emit a frame
        // so the operator sees the failure, then drop it.
        logWarn(`[download-capture] ${e.stack || e.message}`);
        try {
          send({
            type: "slice.download_failed",
            error: String(e.message || e),
            url: safeUrl(download),
            suggested_filename: safeSuggested(download),
          });
        } catch {}
      },
    );
  });
}

async function captureOne({
  download,
  artifactsDir,
  allowlist,
  getCurrentVerb,
}) {
  if (download[HANDLED_MARK]) return;

  const suggested = safeSuggested(download);
  const sourceUrl = safeUrl(download);
  const pageUrl = (() => {
    try {
      return download.page().url();
    } catch {
      return null;
    }
  })();
  const verb = (typeof getCurrentVerb === "function" && getCurrentVerb()) || {};

  if (!extensionAllowed(suggested, allowlist)) {
    send({
      type: "slice.download_skipped",
      reason: "extension_not_in_allowlist",
      suggested_filename: suggested,
      url: sourceUrl,
      page_url: pageUrl,
      verb_index: verb.index ?? null,
      verb_name: verb.name ?? null,
      ts: Date.now(),
    });
    // Cancel the download so Playwright doesn't keep the temp file alive.
    try {
      await download.cancel();
    } catch {}
    return;
  }

  await fsPromises.mkdir(artifactsDir, { recursive: true });
  const target = uniquePathInside(artifactsDir, suggested);
  if (!target) {
    throw new Error(
      `download-capture: refusing to save "${suggested}" — resolves outside $WB_ARTIFACTS_DIR`,
    );
  }

  await download.saveAs(target);

  let bytes = null;
  try {
    bytes = (await fsPromises.stat(target)).size;
  } catch {
    // saveAs resolved successfully so the file should exist; if stat fails
    // we still announce, just without size. Better partial info than no
    // event at all.
  }

  send({
    type: "slice.artifact_saved",
    filename: path.basename(target),
    path: target,
    bytes,
    source: "download",
    provenance: {
      url: sourceUrl,
      suggested_filename: suggested,
      page_url: pageUrl,
      verb_index: verb.index ?? null,
      verb_name: verb.name ?? null,
      ts: Date.now(),
    },
  });
}

function safeSuggested(download) {
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

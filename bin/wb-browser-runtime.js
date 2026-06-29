#!/usr/bin/env node
// wb-browser-runtime — CDP + Playwright sidecar for `wb`.
//
// Speaks wb's line-framed JSON protocol on stdio (see ../README.md). Each
// `browser` fenced block in a workbook arrives as one `slice` message; this
// sidecar dispatches its verbs against a Playwright `Page` connected to a
// vendor-provided CDP endpoint.
//
// The vendor (Browserbase, browser-use, ...) is selected by WB_BROWSER_VENDOR
// and lives behind a provider in ../lib/providers/. Verbs, recording, session
// cache, and substitutions are all vendor-agnostic — they run against a
// Playwright Page regardless of whose chromium is on the other end.
//
// Sessions are cached by `session:` name across slices for the lifetime of
// this process, so a runbook with multiple browser blocks against the same
// vendor reuses one session (and one logged-in browser context).
//
// Verb args support two substitutions, expanded recursively at dispatch time:
//   {{ env.NAME }}        → process.env.NAME
//   {{ artifacts.NAME }}  → contents of $WB_ARTIFACTS_DIR/NAME.txt (or .../NAME)
// The artifacts form lets an earlier bash cell compute a value — OTP, magic
// link, export id — and feed it into a later browser verb without a sidecar
// round-trip. Credentials passed via either form never hit stdout — only the
// verb name + selector make it into the summary.

import readline from "node:readline";
import { chromium } from "playwright-core";
import { send, log } from "../lib/io.js";
import { SessionManager } from "../lib/session-manager.js";
import {
  RecordingManager,
  loadRecordingConfig,
} from "../lib/recording-manager.js";
import { getProvider } from "../lib/providers/index.js";
import {
  attachConsoleBuffer,
  captureFailureDiagnostics,
  classifyError,
} from "../lib/failure.js";
import { installDownloadCapture } from "../lib/download-capture.js";
import { expand, scrubSecrets } from "../lib/substitution.js";
import { SUPPORTS, runVerb, verbName } from "../verbs/index.js";
import pkg from "../package.json" with { type: "json" };

// Read the version from package.json so the `ready` frame can never drift from
// the published version (it used to be a hand-maintained literal that fell out
// of sync). Node >=24 supports JSON import attributes natively.
const VERSION = pkg.version;

// Protocol capability advertisement. `protocol` is the wire version we speak;
// `min_protocol` is the oldest version a peer may speak and still interoperate
// (we keep it equal to `protocol` until we ship a breaking frame change).
// `features` is a coarse capability list above the per-verb `supports` array —
// a client can feature-detect without hard-coding a version→capability map.
const PROTOCOL = "wb-sidecar/1";
const MIN_PROTOCOL = "wb-sidecar/1";
const FEATURES = [
  "recording", // rrweb DOM capture + CDP screencast video
  "pause", // pause_for_human operator handoff
  "substitution", // {{ env.X }} / {{ artifacts.X }}
  "substitution_escape", // \{{ literal-brace escape
  "download_capture", // passive + explicit download artifact capture
  "signed_url_download", // server-side fetch of in-JSON signed export URLs
];

const provider = getProvider();
log(`[provider] ${provider.name}`);

// --- Recording --------------------------------------------------------------
//
// Feature is off unless WB_RECORDING_UPLOAD_URL is set. See
// runtimes/browser/lib/recording-manager.js for the full lifecycle.

const recording = new RecordingManager(loadRecordingConfig());
if (recording.enabled) {
  log(
    `[recording] enabled run_id=${recording.runId} kinds=${recording.activeKinds.join(",")} fps=${recording.fps} quality=${recording.quality}`,
  );
}

// --- Session cache ----------------------------------------------------------

const sessions = new SessionManager();

async function ensureSession(name, { profile, restoreSession } = {}) {
  return sessions.ensure(name, async () => {
    // Vendors charge for the session the moment allocate() returns; if
    // anything after this point throws (getLiveUrl, CDP connect, newContext,
    // recording setup) we must release it explicitly or quota leaks until
    // the vendor's idle timeout. SessionManager only caches a successful
    // return, so on throw there's no half-populated entry to clean up here.
    //
    // Lifecycle timings attached to `slice.session_started` tell operators
    // which step dominated when startup feels slow — usually connectOverCDP
    // against a cold vendor region, but the live-URL fetch and
    // newContext/newPage can each stall independently.
    const t0 = Date.now();
    const restored =
      restoreSession &&
      restoreSession.vendor === provider.name &&
      restoreSession.cdpUrl;
    const allocated = restored
      ? {
          sid: restoreSession.sid,
          cdpUrl: restoreSession.cdpUrl,
          _liveUrl: restoreSession.liveUrl ?? null,
          _restored: true,
        }
      : await provider.allocate({ profile, sessionName: name });
    const tAllocated = Date.now();
    let browser = null;
    try {
      const liveUrl = allocated._liveUrl ?? (await provider.getLiveUrl(allocated));
      // Local provider returns a pre-built Browser via `_browser` (no CDP
      // round-trip — chromium is already launched in-process). Cloud
      // providers return a `cdpUrl` we connect to. Restored sessions
      // always reconnect via CDP.
      browser =
        allocated._browser ??
        (await chromium.connectOverCDP(allocated.cdpUrl));
      const tConnected = Date.now();
      // acceptDownloads is true by default for Playwright-launched contexts,
      // but we set it explicitly so the listener installed below isn't a
      // no-op against a vendor-provided context that opted out.
      const context =
        browser.contexts()[0] ??
        (await browser.newContext({ acceptDownloads: true }));
      const page = context.pages()[0] ?? (await context.newPage());
      const consoleBuffer = attachConsoleBuffer(page);
      const tPageReady = Date.now();

      const info = {
        sid: allocated.sid,
        cdpUrl: allocated.cdpUrl,
        vendor: provider.name,
        browser,
        context,
        page,
        liveUrl,
        recording: null,
        consoleBuffer,
        // Updated by handleSlice's verb loop so the download listener
        // can attach `verb_index`/`verb_name` provenance to artifacts
        // captured while a verb is running. Null between slices.
        currentVerb: null,
      };

      // Install the always-on download listener now, before any slice
      // runs, so a download fired by the very first verb is captured. The
      // returned handle exposes `drainSignedDiagnostics()` — called at clean
      // slice end to flag signed-URL exports that fired no download event.
      info.passiveCapture = installDownloadCapture(context, () => info.currentVerb);

      send({
        type: "slice.session_started",
        session: name,
        session_id: allocated.sid,
        live_url: liveUrl,
        vendor: provider.name,
        restored: Boolean(restored),
        started_at: new Date().toISOString(),
        timings: {
          allocate_ms: tAllocated - t0,
          connect_ms: tConnected - tAllocated,
          page_ready_ms: tPageReady - tConnected,
          total_ms: tPageReady - t0,
        },
      });

      await recording.start(info, name);
      return info;
    } catch (e) {
      if (browser && !allocated._restored) {
        try {
          await browser.close();
        } catch {}
      }
      if (!allocated._restored) await provider.release(allocated.sid);
      throw e;
    }
  });
}
// {{ env.X }} / {{ artifacts.X }} substitution + `\{{` escape + secret scrubbing
// live in lib/substitution.js (extracted so they're unit-testable without
// booting the sidecar).

// --- Slice handler ----------------------------------------------------------

async function handleSlice(msg) {
  // Declared outside the inner try so the outer catch can scrub error
  // messages using whatever secrets were collected before the throw.
  const sliceCtx = {
    lastResult: undefined,
    blockIndex:
      typeof msg?.block_index === "number" ? msg.block_index : null,
    secrets: new Set(),
    // Per-slice cache so `{{ artifacts.otp }}` referenced from 5 verbs
    // hits disk once instead of 5× and doesn't block the event loop
    // per-verb. Freshness across slices is preserved because the cache is
    // scoped to one slice — a bash cell that rewrites the file between
    // slices is seen on the next slice's first read.
    artifactCache: new Map(),
  };
  // Per-slice wall-clock cap. Rust's SLICE_EVENT_TIMEOUT is per-event (resets
  // on every verb.complete), so a chain of 25 × 15s wait_fors that each emit
  // a frame never trips it — the sidecar just runs for 375s while the Rust
  // parent assumes progress. Cap aggregate slice time so we terminate cleanly
  // instead. Default 120s; operators who legitimately need longer can bump
  // via WB_SLICE_DEADLINE_MS.
  const sliceDeadlineMs =
    Number.parseInt(process.env.WB_SLICE_DEADLINE_MS || "", 10) || 120_000;
  const sliceDeadline = Date.now() + sliceDeadlineMs;
  // Top-level guard: any unhandled error must emit slice.failed so the Rust
  // side sees a terminal frame instead of waiting out SLICE_EVENT_TIMEOUT.
  try {
    const verbs = Array.isArray(msg.verbs) ? msg.verbs : [];
    const sessionName = msg.session || "default";
    const restore = msg.restore || null;
    const restoreSession = restore?.state?.session || null;

    let session;
    try {
      session = await ensureSession(sessionName, {
        profile: msg.profile,
        restoreSession,
      });
    } catch (e) {
      send({
        type: "slice.failed",
        code: classifyError(e, "session"),
        error: `session start failed: ${scrubSecrets(e.message, sliceCtx.secrets)}`,
      });
      return;
    }

    // Restore-from-pause: when the Rust side resumes us after a
    // `slice.paused` frame, `restore.state.verb_index` is the index of the
    // verb that paused. We skip *past* it — the verb has no post-resume
    // work (any payload from the operator is already in
    // $WB_ARTIFACTS_DIR/pause_result.json, written by `wb resume` before
    // it re-boots the sidecar). Skipping keeps pause verbs pure: their
    // only job is "halt now," not "halt, then continue."
    const startAt =
      restore?.state?.verb_index !== undefined
        ? Number(restore.state.verb_index) + 1
        : 0;

    for (let i = startAt; i < verbs.length; i++) {
      if (Date.now() >= sliceDeadline) {
        send({
          type: "slice.failed",
          code: "SLICE_TIMEOUT",
          error: `slice exceeded deadline (${sliceDeadlineMs}ms); aborted before verb index ${i} of ${verbs.length}`,
        });
        return;
      }
      const v = verbs[i];
      const name = verbName(v);
      const verbStart = Date.now();
      // Tell the passive download listener which verb to blame for any
      // download that fires during this iteration. Cleared in `finally`
      // so a download arriving between verbs (rare, but possible during
      // a settle/redirect) records as "no current verb" instead of
      // sticking the previous one's name on it.
      session.currentVerb = { index: i, name };
      try {
        const summary = await runVerb(session.page, v, i, sliceCtx, expand);
        // Pause-sentinel escape hatch: a verb signals a mid-slice halt by
        // returning `{ __pause: {...} }`. We translate that into a
        // `slice.paused` frame (so the Rust side writes a pending
        // descriptor and exits 42) and bail out of the verb loop without
        // firing `slice.complete`. Non-pause verbs hand back a plain
        // summary and the loop proceeds normally.
        if (summary && typeof summary === "object" && summary.__pause) {
          const pauseMeta = summary.__pause;
          send({
            type: "slice.paused",
            reason: pauseMeta.reason || "slice.paused",
            message: pauseMeta.message || "",
            context_url: pauseMeta.context_url ?? null,
            resume_on: pauseMeta.resume_on || "operator_click",
            timeout: pauseMeta.timeout ?? null,
            actions: pauseMeta.actions || [{ label: "Resume", value: null }],
            verb: name,
            verb_index: i,
            // `sidecar_state` is forwarded verbatim into the Rust pending
            // descriptor and handed back on resume. The verb can stash
            // whatever it needs here; we always ensure verb_index is set
            // so the dispatcher can compute startAt on re-entry.
            sidecar_state: {
              ...(pauseMeta.sidecar_state || {}),
              verb_index: i,
              session: {
                vendor: session.vendor,
                name: sessionName,
                sid: session.sid,
                cdpUrl: session.cdpUrl,
                liveUrl: session.liveUrl,
              },
            },
          });
          return;
        }
        send({
          type: "verb.complete",
          verb: name,
          verb_index: i,
          summary,
          duration_ms: Date.now() - verbStart,
        });
      } catch (e) {
        const duration_ms = Date.now() - verbStart;
        const clean = scrubSecrets(e.message, sliceCtx.secrets);
        const code = classifyError(e, name);
        const diagnostics = await captureFailureDiagnostics({
          page: session.page,
          artifactsDir: (process.env.WB_ARTIFACTS_DIR || "").trim() || null,
          verbIndex: i,
          consoleBuffer: session.consoleBuffer,
          scrubSecrets,
          secrets: sliceCtx.secrets,
        });
        send({
          type: "verb.failed",
          verb: name,
          verb_index: i,
          code,
          error: clean,
          duration_ms,
          screenshot_path: diagnostics.screenshot_path,
          console_tail: diagnostics.console_tail,
        });
        send({
          type: "slice.failed",
          code,
          error: `verb ${name} (index ${i}): ${clean}`,
        });
        return;
      }
    }
    // Slice ended cleanly — surface any signed-URL export that fired no
    // download event (uncaptured by the explicit `download:` verb) as a
    // diagnostic before we clear the verb pointer, so the frame can still
    // name the last verb that ran. Best-effort: never fails a clean slice.
    try {
      await session.passiveCapture?.drainSignedDiagnostics();
    } catch (e) {
      log(`[download-capture] signed diagnostics drain: ${e.message}`);
    }
    // Clear the listener's "currently running verb" pointer so a stray
    // late-arriving download doesn't get stamped with the last verb's name.
    session.currentVerb = null;
    send({ type: "slice.complete" });
  } catch (e) {
    log(`[slice] unhandled: ${e.stack || e.message}`);
    try {
      send({
        type: "slice.failed",
        code: classifyError(e, "sidecar"),
        error: `sidecar error: ${scrubSecrets(e.message, sliceCtx.secrets)}`,
      });
    } catch {}
  }
}

// --- Shutdown ---------------------------------------------------------------

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Recordings must flush BEFORE browser.close() — rrweb tail drain needs a
  // live page.evaluate() and CDP screencast needs a live CDPSession.
  for (const [name, info] of sessions) {
    try {
      await recording.flush(info, name);
    } catch (e) {
      log(`[shutdown] flush recording ${name}: ${e.message}`);
      // Unhandled flush error → consumer would otherwise see neither an
      // uploaded nor a failed event and have to infer loss from absence.
      try {
        send({
          type: "slice.recording.failed",
          session: name,
          run_id: recording.runId,
          reason: `finalize_error: ${e.message}`,
        });
      } catch {}
    }
  }
  for (const [name, info] of sessions) {
    try {
      await info.browser.close();
    } catch (e) {
      log(`[shutdown] close ${name}: ${e.message}`);
    }
  }
  // Ask the vendor to release sessions explicitly so quota isn't held by
  // orphans waiting for their idle timeout.
  await Promise.all(
    Array.from(sessions.values()).map((s) => provider.release(s.sid)),
  );
  process.exit(0);
}

async function suspend() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Flush recordings while CDP is still connected, but intentionally leave
  // browser contexts and vendor sessions open. The operator needs the live
  // inspector after wb exits 42, and wb resume reconnects using the persisted
  // cdpUrl/liveUrl in sidecar_state.
  for (const [name, info] of sessions) {
    try {
      await recording.flush(info, name);
    } catch (e) {
      log(`[suspend] flush recording ${name}: ${e.message}`);
      try {
        send({
          type: "slice.recording.failed",
          session: name,
          run_id: recording.runId,
          reason: `suspend_finalize_error: ${e.message}`,
        });
      } catch {}
    }
  }
  log("[suspend] leaving browser session alive for external resume");
  process.exit(0);
}

// --- Main loop --------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Per-session dispatch: slices against the same session name serialize
// (shared Playwright page), slices against different names run in parallel.
// SessionManager owns the chain map + the in-flight-create dedup that makes
// this safe — two concurrent slices for "vendor-a" share one provider.allocate
// instead of racing to create two vendor sessions.
function dispatchSlice(msg) {
  const sessionName = msg.session || "default";
  return sessions
    .enqueueOn(sessionName, () => handleSlice(msg))
    .catch((e) => {
      // handleSlice has its own top-level guard that emits slice.failed;
      // this is the last-resort net for a bug that throws past that guard,
      // so the Rust parent never strands waiting on SLICE_EVENT_TIMEOUT.
      log(`[loop] ${e.stack || e.message}`);
      try {
        send({ type: "slice.failed", error: `sidecar loop error: ${e.message}` });
      } catch {}
    });
}

// Shutdown drains all pending per-session work, then tears down. Guarded
// against repeat entries via `shuttingDown` inside shutdown() itself.
async function drainAndShutdown() {
  try {
    await sessions.drainAll();
  } catch (e) {
    log(`[shutdown] drain failed: ${e.message}`);
  }
  await shutdown();
}

async function drainAndSuspend() {
  try {
    await sessions.drainAll();
  } catch (e) {
    log(`[suspend] drain failed: ${e.message}`);
  }
  await suspend();
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log(`[warn] ignoring non-JSON input: ${trimmed.slice(0, 80)}`);
    return;
  }

  switch (msg.type) {
    case "hello":
      send({
        type: "ready",
        runtime: "wb-browser-runtime",
        version: VERSION,
        protocol: PROTOCOL,
        min_protocol: MIN_PROTOCOL,
        supports: SUPPORTS,
        features: FEATURES,
      });
      break;
    case "slice":
      dispatchSlice(msg);
      break;
    case "shutdown":
      drainAndShutdown();
      break;
    case "suspend":
      drainAndSuspend();
      break;
    default:
      log(`[warn] unknown message type: ${msg.type}`);
  }
});

rl.on("close", () => {
  // stdin closed — drain pending work then exit.
  drainAndShutdown();
});

// If the Rust parent SIGTERMs us (timeout, abort, crash), Node's default is
// to exit without running shutdown() — which leaves ffmpeg processes and
// Browserbase sessions orphaned. Route signals through the same drain path.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    log(`[shutdown] received ${sig}`);
    drainAndShutdown();
  });
}

// Log unhandled rejections so a dropped promise doesn't exit the process
// silently between slices. The top-level guards in handleSlice / enqueue
// cover the hot paths; this catches background work (recording uploads, etc).
process.on("unhandledRejection", (reason) => {
  log(`[unhandledRejection] ${reason?.stack || reason}`);
});

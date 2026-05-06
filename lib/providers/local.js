// Local provider — drives a host-installed Playwright Chromium directly
// instead of going to a cloud vendor. Use for dev iteration without
// Browserbase / browser-use cost or latency. Selected via
// WB_BROWSER_VENDOR=local.
//
// Differences from cloud providers:
//   1. allocate() launches a real Chromium via `playwright-core`'s
//      chromium.launch() and returns a pre-built Browser handle in
//      `_browser`. The entry point checks for it and skips the
//      connectOverCDP step that cloud providers require.
//   2. getLiveUrl() returns null — there's no public live-inspector URL
//      for a locally-launched browser. The Rust side just renders the
//      "session started" line without a clickable URL.
//   3. release() is a no-op. The shutdown path already does
//      `info.browser.close()` on every cached session, which terminates
//      the local Chromium process.
//   4. Profile binding is not supported (logged + ignored). For persistent
//      auth across runs use a vendor with profile support, or pin
//      WB_BROWSER_LOCAL_EXECUTABLE_PATH at a Chrome instance with a
//      pre-warmed user-data-dir (advanced; not the supported path).
//
// Resume-after-pause: not supported. The Browser is process-local memory
// and dies with the sidecar; on resume the sidecar re-allocates a fresh
// session. This matches the dev-iteration use case (you're running the
// runbook end-to-end, not pausing on a real wait fence).

import { chromium } from "playwright-core";
import { log } from "../io.js";

// Truthiness for env knobs that default to ON. "0" / "false" / "no" / "off"
// disables; anything else enables. Mirrors the convention used elsewhere.
function isOff(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "0" || s === "false" || s === "no" || s === "off";
}

export function createLocalProvider() {
  return {
    name: "local",

    async allocate({ profile, sessionName: _sessionName } = {}) {
      if (profile) {
        log(
          `[local] profile="${profile}" ignored — local vendor has no profile binding. ` +
            `Use a cloud vendor or persist auth via WB_BROWSER_LOCAL_EXECUTABLE_PATH on a pre-warmed Chrome.`,
        );
      }

      // Headless ON by default; flip with WB_BROWSER_LOCAL_HEADLESS=0 for
      // visible-window dev. Operators debugging a brittle workbook can flip
      // to headed without touching the runbook.
      const headless = !isOff(process.env.WB_BROWSER_LOCAL_HEADLESS);

      // executablePath: explicit override for system Chrome / Chromium.
      // channel: "chrome" / "msedge" / "chrome-beta" — Playwright's named
      // channels for OS-installed browsers (no separate download). At most
      // one of executablePath / channel should be set; if both arrive,
      // executablePath wins (Playwright honors it).
      const executablePath =
        process.env.WB_BROWSER_LOCAL_EXECUTABLE_PATH || undefined;
      const channel = process.env.WB_BROWSER_LOCAL_CHANNEL || undefined;

      log(
        `[local] launching chromium headless=${headless}` +
          ` executablePath=${executablePath ?? "<bundled>"}` +
          ` channel=${channel ?? "<none>"}`,
      );

      let browser;
      try {
        browser = await chromium.launch({
          headless,
          executablePath,
          channel,
        });
      } catch (e) {
        // Most common cause: Playwright's chromium binary not installed.
        // playwright-core ships the API but no browser; the user runs
        // `npx playwright install chromium` once to fetch it. Surface the
        // hint inline so this isn't a guessing game on first run.
        const err = new Error(
          `local browser launch failed: ${e.message}\n` +
            `Hint: install Chromium with \`npx playwright install chromium\`, ` +
            `or set WB_BROWSER_LOCAL_EXECUTABLE_PATH / WB_BROWSER_LOCAL_CHANNEL to use a system browser.`,
        );
        err.code = "SESSION_ALLOCATE_FAILED";
        throw err;
      }

      // sid is for telemetry only — there's no remote session to release.
      // Format: `local-<ms>-<rand>` so it's distinguishable from vendor sids
      // in callback streams and logs.
      const sid = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      return {
        sid,
        // No CDP URL — the entry point sees `_browser` and skips the
        // connectOverCDP path that cloud providers go through.
        cdpUrl: null,
        // Stashed so getLiveUrl() is a sync property read like browser-use.
        _liveUrl: null,
        _browser: browser,
      };
    },

    async getLiveUrl(_allocated) {
      // No public inspector URL for local Chromium. Returning null tells
      // the Rust side to render the "session started" line without a link.
      return null;
    },

    async release(_sid) {
      // Browser teardown happens in the entry-point shutdown loop via
      // `info.browser.close()`, which kills the local Chromium process.
      // Cloud providers need a separate vendor REST call here; local
      // doesn't.
    },
  };
}

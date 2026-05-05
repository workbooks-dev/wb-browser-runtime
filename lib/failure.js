// Failure-event helpers — classifier + screenshot/console capture.
//
// `verb.failed` and `slice.failed` carry a stable `code` field so agents can
// switch on category instead of regex-matching English. Verb failures also
// snapshot a screenshot (best-effort) and the recent console buffer so
// post-hoc debugging doesn't depend on a single line of stderr.
//
// All capture is best-effort: a failed screenshot or a missing artifacts dir
// must NOT prevent the failure event from emitting.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CONSOLE_ENTRIES = 50;
const MAX_LINE_CHARS = 512;

// Map a verb-execution error to a stable code. Order matters: an explicit
// `err.code` (e.g. set by a provider for AUTH_FAILED) wins over inference.
export function classifyError(err, verbName) {
  if (err && typeof err.code === "string" && err.code) return err.code;
  if (!err) return "INTERNAL_ERROR";
  const name = err.name || "";
  const msg = String(err.message || "");
  if (name === "TimeoutError") {
    if (verbName === "goto") return "NAV_TIMEOUT";
    if (/load\s*state|networkidle|navigation|wait\s+for\s+url/i.test(msg)) {
      return "NAV_TIMEOUT";
    }
    return "SELECTOR_NOT_FOUND";
  }
  if (verbName === "eval" || verbName === "extract") return "SCRIPT_ERROR";
  return "INTERNAL_ERROR";
}

// Attach console + pageerror listeners to a Page. Returns the buffer object
// (FIFO-capped) so callers can stash it next to the Page (e.g. on the
// SessionManager `info`). Calling twice on the same Page would double-record;
// callers are expected to only invoke once per page.
export function attachConsoleBuffer(page) {
  const buffer = [];
  const push = (entry) => {
    const text = String(entry.text ?? "");
    buffer.push({
      type: entry.type,
      text: text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text,
      at: entry.at ?? Date.now(),
    });
    while (buffer.length > MAX_CONSOLE_ENTRIES) buffer.shift();
  };
  page.on("console", (msg) => {
    push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    push({ type: "pageerror", text: err?.message ?? String(err) });
  });
  return buffer;
}

// Snapshot console buffer (with secret scrubbing) and capture a screenshot.
// Returns `{ screenshot_path, console_tail }`. Both fields may be null/empty;
// caller decides whether to attach them to the failure event.
export async function captureFailureDiagnostics({
  page,
  artifactsDir,
  verbIndex,
  consoleBuffer,
  scrubSecrets,
  secrets,
}) {
  const out = { screenshot_path: null, console_tail: [] };

  if (Array.isArray(consoleBuffer)) {
    const scrub = typeof scrubSecrets === "function" ? scrubSecrets : null;
    out.console_tail = consoleBuffer.map((entry) => ({
      type: entry.type,
      text: scrub ? scrub(entry.text, secrets) : String(entry.text),
      at: entry.at,
    }));
  }

  if (page && artifactsDir) {
    try {
      const filename = `wb-failure-${verbIndex}-${Date.now()}.png`;
      const fullPath = path.join(artifactsDir, filename);
      const tmp = `${fullPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      const buf = await page.screenshot({ type: "png" });
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, fullPath);
      out.screenshot_path = filename;
    } catch {
      // Screenshot capture is best-effort; don't let a Page crash or a
      // permission error mask the underlying verb failure.
    }
  }

  return out;
}

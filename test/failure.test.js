import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  classifyError,
  attachConsoleBuffer,
  captureFailureDiagnostics,
} from "../lib/failure.js";

// --- classifyError ----------------------------------------------------------

test("classifyError: explicit err.code wins", () => {
  const err = Object.assign(new Error("anything"), { code: "AUTH_FAILED" });
  assert.equal(classifyError(err, "click"), "AUTH_FAILED");
});

test("classifyError: TimeoutError on goto → NAV_TIMEOUT", () => {
  const err = Object.assign(new Error("nav timeout"), { name: "TimeoutError" });
  assert.equal(classifyError(err, "goto"), "NAV_TIMEOUT");
});

test("classifyError: TimeoutError mentioning load state → NAV_TIMEOUT", () => {
  const err = Object.assign(
    new Error("page.waitForLoadState: Timeout 30000ms exceeded"),
    { name: "TimeoutError" },
  );
  assert.equal(classifyError(err, "wait_for_network_idle"), "NAV_TIMEOUT");
});

test("classifyError: TimeoutError on click → SELECTOR_NOT_FOUND", () => {
  const err = Object.assign(
    new Error("locator.click: Timeout 10000ms exceeded waiting for #x"),
    { name: "TimeoutError" },
  );
  assert.equal(classifyError(err, "click"), "SELECTOR_NOT_FOUND");
});

test("classifyError: eval/extract throw → SCRIPT_ERROR", () => {
  const err = new Error("ReferenceError: foo is not defined");
  assert.equal(classifyError(err, "eval"), "SCRIPT_ERROR");
  assert.equal(classifyError(err, "extract"), "SCRIPT_ERROR");
});

test("classifyError: anything else → INTERNAL_ERROR", () => {
  assert.equal(classifyError(new Error("???"), "fill"), "INTERNAL_ERROR");
  assert.equal(classifyError(null, "click"), "INTERNAL_ERROR");
});

// --- attachConsoleBuffer ----------------------------------------------------

test("attachConsoleBuffer: records console + pageerror events", () => {
  const handlers = {};
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  const buffer = attachConsoleBuffer(page);
  handlers.console({ type: () => "log", text: () => "hello" });
  handlers.pageerror(new Error("boom"));
  assert.equal(buffer.length, 2);
  assert.equal(buffer[0].type, "log");
  assert.equal(buffer[0].text, "hello");
  assert.equal(buffer[1].type, "pageerror");
  assert.equal(buffer[1].text, "boom");
});

test("attachConsoleBuffer: caps at 50 entries (FIFO)", () => {
  const handlers = {};
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  const buffer = attachConsoleBuffer(page);
  for (let i = 0; i < 60; i++) {
    handlers.console({ type: () => "log", text: () => `line ${i}` });
  }
  assert.equal(buffer.length, 50);
  // Oldest survivors should be line 10..59 (we dropped 0..9).
  assert.equal(buffer[0].text, "line 10");
  assert.equal(buffer[49].text, "line 59");
});

test("attachConsoleBuffer: truncates very long lines", () => {
  const handlers = {};
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  const buffer = attachConsoleBuffer(page);
  const huge = "x".repeat(2000);
  handlers.console({ type: () => "log", text: () => huge });
  assert.equal(buffer[0].text.length, 512);
});

// --- captureFailureDiagnostics ---------------------------------------------

test("captureFailureDiagnostics: writes screenshot + forwards console_tail", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wb-failure-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const page = {
    async screenshot() {
      return png;
    },
  };
  const consoleBuffer = [
    { type: "log", text: "before failure", at: 1 },
    { type: "error", text: "bad token", at: 2 },
  ];

  const out = await captureFailureDiagnostics({
    page,
    artifactsDir: dir,
    verbIndex: 7,
    consoleBuffer,
    scrubSecrets: (msg) => msg.replace("token", "«***»"),
    secrets: new Set(),
  });

  assert.match(out.screenshot_path, /^wb-failure-7-\d+\.png$/);
  assert.equal(out.console_tail.length, 2);
  // Scrubbing applied to text field.
  assert.equal(out.console_tail[1].text, "bad «***»");

  const written = await readdir(dir);
  assert.equal(written.length, 1);
  const buf = await readFile(path.join(dir, written[0]));
  assert.deepEqual(buf, png);
});

test("captureFailureDiagnostics: best-effort when artifactsDir unset", async () => {
  const out = await captureFailureDiagnostics({
    page: {
      async screenshot() {
        return Buffer.alloc(0);
      },
    },
    artifactsDir: null,
    verbIndex: 0,
    consoleBuffer: [],
  });
  assert.equal(out.screenshot_path, null);
  assert.deepEqual(out.console_tail, []);
});

test("captureFailureDiagnostics: best-effort when screenshot throws", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wb-failure-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const out = await captureFailureDiagnostics({
    page: {
      async screenshot() {
        throw new Error("page closed");
      },
    },
    artifactsDir: dir,
    verbIndex: 1,
    consoleBuffer: [{ type: "log", text: "still here", at: 1 }],
  });
  assert.equal(out.screenshot_path, null);
  assert.equal(out.console_tail.length, 1);
});

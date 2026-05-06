// Tests for the local provider — exercises the bits that don't depend on
// a real Chromium (vendor selection, env-knob parsing, error envelope on
// launch failure, no-op release). The "actually launch chromium" path is
// covered by manual smoke testing — running it in unit tests requires
// `npx playwright install chromium` which we don't want to make a CI
// prerequisite for the unit suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalProvider } from "../lib/providers/local.js";
import { getProvider } from "../lib/providers/index.js";

// --- Selection -------------------------------------------------------------

test("getProvider() returns local provider for WB_BROWSER_VENDOR=local", () => {
  const prev = process.env.WB_BROWSER_VENDOR;
  process.env.WB_BROWSER_VENDOR = "local";
  try {
    const p = getProvider();
    assert.equal(p.name, "local");
  } finally {
    if (prev === undefined) delete process.env.WB_BROWSER_VENDOR;
    else process.env.WB_BROWSER_VENDOR = prev;
  }
});

test("getProvider() unknown vendor lists local in the error", () => {
  const prev = process.env.WB_BROWSER_VENDOR;
  process.env.WB_BROWSER_VENDOR = "definitely-not-a-vendor";
  try {
    assert.throws(() => getProvider(), /local/);
  } finally {
    if (prev === undefined) delete process.env.WB_BROWSER_VENDOR;
    else process.env.WB_BROWSER_VENDOR = prev;
  }
});

// --- Provider shape --------------------------------------------------------

test("local provider exposes the expected interface", () => {
  const p = createLocalProvider();
  assert.equal(p.name, "local");
  assert.equal(typeof p.allocate, "function");
  assert.equal(typeof p.getLiveUrl, "function");
  assert.equal(typeof p.release, "function");
});

test("local provider getLiveUrl always returns null", async () => {
  const p = createLocalProvider();
  assert.equal(await p.getLiveUrl({}), null);
  assert.equal(await p.getLiveUrl({ sid: "local-123" }), null);
});

test("local provider release is a no-op (never throws, returns undefined)", async () => {
  const p = createLocalProvider();
  // Doesn't even matter what sid is passed — there's no remote to release.
  assert.equal(await p.release("local-anything"), undefined);
  assert.equal(await p.release(undefined), undefined);
});

// --- Launch failure envelope -----------------------------------------------

test("allocate() wraps launch failure with install-hint and AUTH/ALLOC code", async () => {
  // Force a launch failure by pointing at a path that definitely doesn't
  // exist. Playwright will throw; the provider should rewrap the message
  // with our install hint and tag the error with code SESSION_ALLOCATE_FAILED.
  const prev = process.env.WB_BROWSER_LOCAL_EXECUTABLE_PATH;
  process.env.WB_BROWSER_LOCAL_EXECUTABLE_PATH =
    "/definitely/does/not/exist/chromium";
  try {
    const p = createLocalProvider();
    let caught;
    try {
      await p.allocate({});
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "expected allocate() to throw");
    assert.equal(caught.code, "SESSION_ALLOCATE_FAILED");
    assert.match(caught.message, /local browser launch failed/);
    assert.match(caught.message, /npx playwright install chromium/);
  } finally {
    if (prev === undefined) delete process.env.WB_BROWSER_LOCAL_EXECUTABLE_PATH;
    else process.env.WB_BROWSER_LOCAL_EXECUTABLE_PATH = prev;
  }
});

// Tests for loadMaskConfig() in lib/recording-manager.js — the env-driven rrweb
// mask/block/ignore selector knobs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadMaskConfig } from "../lib/recording-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RRWEB_VENDOR_PATH = path.join(
  __dirname,
  "..",
  "vendor",
  "rrweb-record.min.js",
);

function withEnv(t, vars) {
  const keys = [
    "WB_RECORDING_MASK_ALL_INPUTS",
    "WB_RECORDING_MASK_TEXT_SELECTOR",
    "WB_RECORDING_BLOCK_SELECTOR",
    "WB_RECORDING_IGNORE_SELECTOR",
  ];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  t.after(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test("loadMaskConfig defaults: maskAllInputs on, selectors null", (t) => {
  withEnv(t, {});
  assert.deepEqual(loadMaskConfig(), {
    maskAllInputs: true,
    maskTextSelector: null,
    blockSelector: null,
  });
});

test("WB_RECORDING_MASK_ALL_INPUTS=0 disables input masking", (t) => {
  withEnv(t, { WB_RECORDING_MASK_ALL_INPUTS: "0" });
  assert.equal(loadMaskConfig().maskAllInputs, false);
});

test("custom mask + block selectors are read and trimmed", (t) => {
  withEnv(t, {
    WB_RECORDING_MASK_TEXT_SELECTOR: "  .ssn, .balance ",
    WB_RECORDING_BLOCK_SELECTOR: ".secret",
  });
  const cfg = loadMaskConfig();
  assert.equal(cfg.maskTextSelector, ".ssn, .balance");
  assert.equal(cfg.blockSelector, ".secret");
});

test("empty-string selector env vars resolve to null (not '')", (t) => {
  withEnv(t, { WB_RECORDING_MASK_TEXT_SELECTOR: "   " });
  assert.equal(loadMaskConfig().maskTextSelector, null);
});

// --- Privacy guarantee: ignore selector must take effect via blockSelector ---

test("WB_RECORDING_IGNORE_SELECTOR folds into the effective block selector", (t) => {
  withEnv(t, { WB_RECORDING_IGNORE_SELECTOR: "  input[name=card] " });
  const cfg = loadMaskConfig();
  // The vendored bundle has no ignoreSelector support, so the ignore value
  // must surface as a (supported, stronger) blockSelector — and never leak out
  // as a no-op ignoreSelector field.
  assert.equal(cfg.blockSelector, "input[name=card]");
  assert.equal(cfg.ignoreSelector, undefined);
});

test("ignore selector is unioned with an explicit block selector (neither lost)", (t) => {
  withEnv(t, {
    WB_RECORDING_BLOCK_SELECTOR: ".secret",
    WB_RECORDING_IGNORE_SELECTOR: "input[name=card]",
  });
  const cfg = loadMaskConfig();
  assert.equal(cfg.blockSelector, ".secret, input[name=card]");
});

// --- Guard against a future silent-no-op regression of the vendored bundle ---

test("vendored rrweb bundle supports the option tokens this code relies on", () => {
  const src = readFileSync(RRWEB_VENDOR_PATH, "utf8");
  for (const tok of ["blockSelector", "maskTextSelector", "maskAllInputs"]) {
    assert.ok(
      src.includes(tok),
      `vendored rrweb-record.min.js is missing "${tok}" — recording privacy options would be silently dropped`,
    );
  }
  // ignoreSelector is intentionally NOT supported by this bundle; that is why
  // WB_RECORDING_IGNORE_SELECTOR is mapped onto blockSelector. If a future
  // bundle adds it, revisit loadMaskConfig (we could pass it through directly).
  assert.ok(
    !src.includes("ignoreSelector"),
    "vendored bundle now supports ignoreSelector — revisit the blockSelector fold in loadMaskConfig",
  );
});

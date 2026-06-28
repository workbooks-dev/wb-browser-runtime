// Tests for loadMaskConfig() in lib/recording-manager.js — the env-driven rrweb
// mask/block/ignore selector knobs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadMaskConfig } from "../lib/recording-manager.js";

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
    ignoreSelector: null,
  });
});

test("WB_RECORDING_MASK_ALL_INPUTS=0 disables input masking", (t) => {
  withEnv(t, { WB_RECORDING_MASK_ALL_INPUTS: "0" });
  assert.equal(loadMaskConfig().maskAllInputs, false);
});

test("custom mask/block/ignore selectors are read and trimmed", (t) => {
  withEnv(t, {
    WB_RECORDING_MASK_TEXT_SELECTOR: "  .ssn, .balance ",
    WB_RECORDING_BLOCK_SELECTOR: ".secret",
    WB_RECORDING_IGNORE_SELECTOR: "input[name=card]",
  });
  const cfg = loadMaskConfig();
  assert.equal(cfg.maskTextSelector, ".ssn, .balance");
  assert.equal(cfg.blockSelector, ".secret");
  assert.equal(cfg.ignoreSelector, "input[name=card]");
});

test("empty-string selector env vars resolve to null (not '')", (t) => {
  withEnv(t, { WB_RECORDING_MASK_TEXT_SELECTOR: "   " });
  assert.equal(loadMaskConfig().maskTextSelector, null);
});

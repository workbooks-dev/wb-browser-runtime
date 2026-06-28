// Tests for lib/substitution.js — {{ env.X }} / {{ artifacts.X }} expansion,
// the `\{{` literal-brace escape, the missing-value policy, and secret
// scrubbing. No browser, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expand, scrubSecrets } from "../lib/substitution.js";

function withEnv(t, vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("expand substitutes {{ env.X }} from process.env", (t) => {
  withEnv(t, { WB_TEST_TOKEN: "s3cr3t" });
  assert.equal(expand("Bearer {{ env.WB_TEST_TOKEN }}"), "Bearer s3cr3t");
});

test("expand recurses into arrays and objects", (t) => {
  withEnv(t, { WB_TEST_A: "1", WB_TEST_B: "2" });
  const out = expand({
    headers: ["x={{ env.WB_TEST_A }}", "y={{ env.WB_TEST_B }}"],
    nested: { z: "{{ env.WB_TEST_A }}" },
    n: 42,
  });
  assert.deepEqual(out, {
    headers: ["x=1", "y=2"],
    nested: { z: "1" },
    n: 42,
  });
});

test("\\{{ escapes to a literal {{ and is not substituted", (t) => {
  withEnv(t, { WB_TEST_TOKEN: "should-not-appear" });
  // \{{ env.WB_TEST_TOKEN }} should round-trip to literal {{ env.WB_TEST_TOKEN }}
  assert.equal(
    expand("literal: \\{{ env.WB_TEST_TOKEN }}"),
    "literal: {{ env.WB_TEST_TOKEN }}",
  );
});

test("escape and real substitution coexist in one string", (t) => {
  withEnv(t, { WB_TEST_TOKEN: "abc" });
  assert.equal(
    expand("\\{{ env.WB_TEST_TOKEN }} vs {{ env.WB_TEST_TOKEN }}"),
    "{{ env.WB_TEST_TOKEN }} vs abc",
  );
});

test("missing env: default warn policy substitutes empty string", (t) => {
  withEnv(t, { WB_MISSING_X: undefined, WB_SUBSTITUTION_ON_MISSING: undefined });
  assert.equal(expand("[{{ env.WB_MISSING_X }}]"), "[]");
});

test("missing env: error policy throws", (t) => {
  withEnv(t, { WB_MISSING_X: undefined, WB_SUBSTITUTION_ON_MISSING: "error" });
  assert.throws(
    () => expand("{{ env.WB_MISSING_X }}"),
    /substitution: env\.WB_MISSING_X is not set/,
  );
});

test("expand reads {{ artifacts.X }} from WB_ARTIFACTS_DIR (.txt preferred)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wb-subst-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "otp.txt"), "123456\n");
  withEnv(t, { WB_ARTIFACTS_DIR: dir });
  // trailing newline is trimmed
  assert.equal(expand("code={{ artifacts.otp }}"), "code=123456");
});

test("artifact cache: second reference in the same expand call hits cache", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wb-subst-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "val.txt"), "cached");
  withEnv(t, { WB_ARTIFACTS_DIR: dir });
  const cache = new Map();
  const out = expand(
    ["{{ artifacts.val }}", "{{ artifacts.val }}"],
    null,
    cache,
  );
  assert.deepEqual(out, ["cached", "cached"]);
  assert.equal(cache.get("val"), "cached");
});

test("collected secrets feed scrubSecrets", (t) => {
  withEnv(t, { WB_TEST_TOKEN: "supersecretvalue" });
  const collected = new Set();
  const url = expand("https://api/?t={{ env.WB_TEST_TOKEN }}", collected);
  assert.ok(collected.has("supersecretvalue"));
  const err = `fetch failed for ${url}`;
  assert.equal(
    scrubSecrets(err, collected),
    "fetch failed for https://api/?t=«***»",
  );
});

test("scrubSecrets is a no-op with no secrets", () => {
  assert.equal(scrubSecrets("plain message", null), "plain message");
  assert.equal(scrubSecrets(null, new Set(["x"])), "");
});

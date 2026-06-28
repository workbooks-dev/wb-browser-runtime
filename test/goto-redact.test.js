// Regression test for the goto secret-leak bug: when a runbook substitutes a
// secret into the URL (e.g. ?token={{ env.TOKEN }}), the resolved URL must not
// reach the verb.complete summary in cleartext. goto scrubs collected secrets
// (ctx.secrets) out of its summary the same way error messages are scrubbed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { VERB_REGISTRY } from "../verbs/index.js";
import { createStubPage } from "../lib/stub-page.js";

test("goto masks a secret present in the URL summary", async () => {
  const secret = "supersecrettoken123";
  const url = `https://api.example.com/?token=${secret}`;
  const page = createStubPage();
  const ctx = { secrets: new Set([secret]) };

  const summary = await VERB_REGISTRY.goto.execute(page, { url }, ctx);

  // Navigation behavior is unchanged: the real (unredacted) URL was passed
  // to page.goto.
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].verb, "goto");
  assert.equal(page.calls[0].url, url);

  // The raw secret must never appear in the surfaced summary.
  assert.ok(
    !summary.includes(secret),
    `summary leaked secret: ${summary}`,
  );
  assert.equal(summary, "→ https://api.example.com/?token=«***»");
});

test("goto summary is unchanged when no secret matches", async () => {
  const page = createStubPage();
  const ctx = { secrets: new Set(["unrelated-value"]) };
  const summary = await VERB_REGISTRY.goto.execute(
    page,
    { url: "https://example.com" },
    ctx,
  );
  assert.equal(summary, "→ https://example.com");
});

test("goto works with no ctx/secrets (back-compat)", async () => {
  const page = createStubPage();
  const summary = await VERB_REGISTRY.goto.execute(page, {
    url: "https://example.com",
  });
  assert.equal(summary, "→ https://example.com");
});

import { scrubSecrets } from "../lib/substitution.js";

export default {
  name: "goto",
  primaryKey: "url",
  async execute(page, args, ctx) {
    const url = args.url ?? "";
    const waitUntil = args.wait_until ?? "domcontentloaded";
    await page.goto(url, { waitUntil, timeout: args.timeout ?? 30_000 });
    // The resolved URL can carry a substituted secret (e.g.
    // ?token={{ env.TOKEN }}). Scrub any collected secret value out of the
    // summary before it crosses into the verb.complete event stream — the
    // same mechanism error messages use (lib/substitution.scrubSecrets).
    return `→ ${scrubSecrets(page.url(), ctx?.secrets)}`;
  },
};

// Wait until the page reports "networkidle" — at most one in-flight request
// for >=500ms. SPA flows that don't have a stable selector to wait on need
// this; otherwise the next verb fires before async XHRs settle and reads
// stale DOM.

const DEFAULT_TIMEOUT_MS = 30_000;

// Parse "30s" / "2m" / "500ms" / 5000 / "5000" into ms. Anything malformed
// falls back to the default — the sidecar would rather time out at a known
// bound than throw on a typo.
function parseTimeoutMs(value) {
  if (value == null) return DEFAULT_TIMEOUT_MS;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return DEFAULT_TIMEOUT_MS;
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_TIMEOUT_MS;
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) {
    const asNum = Number(trimmed);
    return Number.isFinite(asNum) ? asNum : DEFAULT_TIMEOUT_MS;
  }
  const n = Number(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return DEFAULT_TIMEOUT_MS;
  }
}

export default {
  name: "wait_for_network_idle",
  primaryKey: "timeout",
  async execute(page, args) {
    const raw = args.timeout;
    const timeout = parseTimeoutMs(raw);
    await page.waitForLoadState("networkidle", { timeout });
    const summary =
      typeof raw === "string" && raw.trim() !== ""
        ? `network idle (timeout=${raw.trim()})`
        : `network idle (timeout=${timeout}ms)`;
    return summary;
  },
};

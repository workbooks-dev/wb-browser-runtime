import dns from "node:dns";
import { isIP } from "node:net";
import { log } from "./io.js";

export async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<unreadable>";
  }
}

// --- Body-read timeout handoff ---------------------------------------------
//
// retryableFetch's AbortController timer normally fires until fetch() resolves
// (headers received) and is then cleared in `finally`. That leaves the *body*
// read unbounded: a server can dribble bytes forever after sending headers.
//
// `keepBodyTimeout: true` is an opt-in for callers that consume the body
// themselves (the signed-URL download path). When set, on a successful (2xx)
// response we do NOT clear the timer — instead we stash the timer + controller
// in a WeakMap keyed by the Response so the caller can either:
//   - releaseBodyTimeout(res): clear it once the body is fully consumed, or
//   - abortBody(res): abort the in-flight body read (e.g. size cap tripped).
// If the caller never releases, the timer still fires and aborts the socket,
// so a hung body read can't wedge the process. Other callers (default
// keepBodyTimeout=false) are unaffected — their timer is cleared as before.
const bodyTimers = new WeakMap();

export function releaseBodyTimeout(res) {
  const entry = bodyTimers.get(res);
  if (entry) {
    clearTimeout(entry.timer);
    bodyTimers.delete(res);
  }
}

export function abortBody(res) {
  const entry = bodyTimers.get(res);
  if (entry) {
    try {
      entry.controller.abort();
    } catch {}
  }
}

// Best-effort cancel/drain of a response body so a non-OK or redirect response
// doesn't leak the underlying socket while we throw or follow a redirect.
export async function drainResponseBody(res) {
  try {
    if (res?.body?.cancel) {
      await res.body.cancel();
    } else if (res?.body) {
      // Fall back to consuming it if cancel() isn't available.
      await res.arrayBuffer().catch(() => {});
    }
  } catch {}
}

// --- SSRF guard: private/loopback/link-local IP detection ------------------

function isPrivateIPv4(addr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0) return true; // 0.0.0.0/8 (includes the unspecified address)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

function isPrivateIPv6(addr) {
  let s = String(addr).toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // strip zone id
  if (s === "::1") return true; // loopback
  if (s === "::") return true; // unspecified
  // IPv4-mapped / IPv4-embedded (e.g. ::ffff:127.0.0.1, ::127.0.0.1)
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4 && isPrivateIPv4(v4[1])) return true;
  const first = s.split(":")[0];
  if (/^f[cd]/.test(first)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  return false;
}

// True if a literal IP address falls in a private/loopback/link-local range.
export function isPrivateIp(addr) {
  const fam = isIP(addr);
  if (fam === 4) return isPrivateIPv4(addr);
  if (fam === 6) return isPrivateIPv6(addr);
  return false;
}

// Validate a single URL as an allowed download target. Applies the caller's
// host allowlist (the SAME check used on the initial URL — this is what makes
// redirect following safe) and, unless explicitly allowed, rejects any host
// that is a private IP literal or resolves to one (DNS rebinding / SSRF).
// Throws on rejection; resolves on success.
export async function assertAllowedTarget(
  urlStr,
  { validateHost = null, allowPrivateIp = false } = {},
) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`blocked target: unparseable URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked target: unsupported scheme "${u.protocol}"`);
  }
  const host = u.host.toLowerCase(); // includes port — matches the picker
  const hostname = u.hostname.toLowerCase();
  if (validateHost && !validateHost(host)) {
    throw new Error(`blocked target: host not allowed: ${host}`);
  }
  if (allowPrivateIp) return;
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`blocked target: private/loopback IP ${hostname}`);
    }
    return;
  }
  let results;
  try {
    results = await dns.promises.lookup(hostname, { all: true });
  } catch (e) {
    // Fail closed: a host we can't resolve isn't a host we should fetch.
    throw new Error(`blocked target: could not resolve ${hostname}: ${e?.message || e}`);
  }
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      throw new Error(
        `blocked target: ${hostname} resolves to private/loopback IP ${r.address}`,
      );
    }
  }
}

// Retry transient network + 5xx/429 failures with short exponential backoff.
// Each attempt gets its own AbortController + timeout; caller-passed signals
// are not plumbed through since we don't have a cancellation story above this
// layer. Non-retryable statuses (4xx except 429) are returned immediately for
// the caller to handle.
//
// `bodyFactory`, when set, is invoked per attempt to produce a fresh body —
// required for streaming uploads where the previous attempt consumed the
// stream. Takes precedence over opts.body.
//
// `keepBodyTimeout`, when set, hands the attempt's abort timer to the caller on
// a successful (2xx) response instead of clearing it, so the body-read window
// stays bounded. See releaseBodyTimeout / abortBody above.
export async function retryableFetch(
  url,
  opts = {},
  label,
  { timeoutMs = 30_000, bodyFactory = null, keepBodyTimeout = false } = {},
) {
  const delays = [100, 500];
  let lastErr = null;
  let lastRes = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      const prev = lastRes
        ? `status=${lastRes.status}`
        : `err=${lastErr?.message || lastErr}`;
      log(`[retry] ${label} attempt ${attempt + 1}/3 (${prev})`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let handedOff = false;
    try {
      const fetchOpts = { ...opts, signal: controller.signal };
      if (bodyFactory) {
        fetchOpts.body = bodyFactory();
        // undici requires duplex: "half" for streaming (non-Buffer, non-string)
        // request bodies. Omitting it throws at request time.
        fetchOpts.duplex = "half";
      }
      const res = await fetch(url, fetchOpts);
      if (res.ok) {
        if (keepBodyTimeout) {
          // Keep the timer armed until the caller consumes the body.
          handedOff = true;
          bodyTimers.set(res, { timer, controller });
        }
        return res;
      }
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        lastRes = res;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      continue;
    } finally {
      if (!handedOff) clearTimeout(timer);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr;
}

export const MAX_DOWNLOAD_REDIRECTS = 5;

// Fetch a download target with manual redirect handling and an SSRF guard.
// Every hop (the initial URL and each Location target) is re-validated with
// assertAllowedTarget before it is fetched, so a 3xx to an unvalidated or
// private host is rejected instead of silently followed. Redirect bodies are
// drained between hops. Returns the final (non-redirect) Response; the caller
// owns the body (use keepBodyTimeout semantics: releaseBodyTimeout when done).
export async function guardedDownloadFetch(
  url,
  {
    timeoutMs = 30_000,
    validateHost = null,
    allowPrivateIp = false,
    maxRedirects = MAX_DOWNLOAD_REDIRECTS,
    label,
  } = {},
) {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertAllowedTarget(current, { validateHost, allowPrivateIp });
    const res = await retryableFetch(
      current,
      { method: "GET", redirect: "manual" },
      label,
      { timeoutMs, keepBodyTimeout: true },
    );
    const status = res.status;
    if (status >= 300 && status < 400) {
      const loc = res.headers?.get?.("location");
      if (loc) {
        // A 3xx is not res.ok, so it was never handed off — its timer is
        // already cleared. Drain the redirect body and re-validate the target.
        await drainResponseBody(res);
        if (hop >= maxRedirects) {
          throw new Error(`too many redirects (> ${maxRedirects})`);
        }
        let next;
        try {
          next = new URL(loc, current).toString();
        } catch {
          throw new Error(`blocked target: unparseable redirect Location`);
        }
        current = next;
        continue;
      }
    }
    return res;
  }
}

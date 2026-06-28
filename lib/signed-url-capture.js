// Signed-URL export capture.
//
// Some SaaS "Download" buttons never produce a Playwright `download` event or
// an in-page Blob. Instead the app calls a same-origin API that returns JSON
// like `{ "download_url": "https://bucket.s3.amazonaws.com/...?<signed>" }`
// and then navigates to that URL. A page-side `fetch(signedUrl)` usually fails
// because the object store's CORS policy doesn't allow the app origin to read
// the bytes — so the only reliable place to fetch it is the sidecar process,
// where CORS doesn't apply.
//
// This module supplies:
//   - SIGNED_PAGE_HOOK / SIGNED_POLL_SCRIPT — page-side instrumentation that
//     wraps fetch + XHR, inspects small same-origin JSON responses, and stashes
//     any http(s) URL fields it finds on `window.__wbSignedCandidates`.
//   - pure helpers (isSignedHost, redactSignedUrl, extractUrlFields,
//     pickSignedCandidate, parseSignedConfig) that the `download` verb uses to
//     decide which captured URL to fetch server-side.
//
// The bytes are downloaded by the verb via lib/http.js's retryableFetch. Signed
// query credentials are redacted everywhere they cross the stdio boundary; the
// full URL lives only in sidecar memory for the duration of the fetch.

// Object-store / CDN hosts that hand out pre-signed, credential-bearing URLs.
// A match means "this looks like an export download, not a normal app API call"
// — the gate that keeps auto-mode from grabbing arbitrary same-origin URLs.
const SIGNED_HOST_PATTERNS = [
  // S3: s3.amazonaws.com, s3.us-east-1.amazonaws.com, s3-us-west-2.amazonaws.com,
  //     bucket.s3.amazonaws.com, bucket.s3.us-east-1.amazonaws.com
  /(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i,
  // Google Cloud Storage
  /(^|\.)storage\.googleapis\.com$/i,
  /(^|\.)storage\.cloud\.google\.com$/i,
  // CloudFront
  /(^|\.)cloudfront\.net$/i,
  // Azure Blob Storage
  /\.blob\.core\.windows\.net$/i,
  // Cloudflare R2
  /\.r2\.cloudflarestorage\.com$/i,
];

export function isSignedHost(host) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return SIGNED_HOST_PATTERNS.some((re) => re.test(h));
}

// Drop the query string (where signed credentials live) but keep origin + path
// so diagnostics stay useful. Falls back to a naive split when URL parsing
// fails so a malformed value still can't leak its query.
export function redactSignedUrl(url) {
  const s = String(url || "");
  try {
    const u = new URL(s);
    return u.search ? `${u.origin}${u.pathname}?<redacted>` : `${u.origin}${u.pathname}`;
  } catch {
    const i = s.indexOf("?");
    return i >= 0 ? `${s.slice(0, i)}?<redacted>` : s;
  }
}

// Recursively collect every http(s) string value in a parsed JSON object.
// Bounded in depth and count so a pathological response can't blow the stack
// or the buffer. Returns `[{ field, url }]` with dotted field paths.
export function extractUrlFields(data, maxDepth = 6, maxUrls = 30) {
  const out = [];
  const visit = (node, fieldPath, depth) => {
    if (depth > maxDepth || out.length >= maxUrls) return;
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node)) out.push({ field: fieldPath, url: node });
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++)
        visit(node[i], `${fieldPath}[${i}]`, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        visit(node[k], fieldPath ? `${fieldPath}.${k}` : k, depth + 1);
      }
    }
  };
  visit(data, "", 0);
  return out;
}

// Leaf field name from a dotted/indexed path: "data.export.download_url" →
// "download_url", "files[0].url" → "url". Used to match against a caller's
// `json_fields` allowlist.
function leafField(fieldPath) {
  const last = String(fieldPath || "")
    .split(".")
    .pop();
  return last.replace(/\[\d+\]$/, "");
}

// Normalize `args.signed_url` into a resolved policy.
//   undefined / "auto"        → { enabled: "auto" }   (recognized hosts only)
//   false / { enabled: false } → { enabled: false }   (feature off)
//   true                       → { enabled: true }
//   { enabled, hosts, json_fields } → that, normalized
// In "auto" mode only recognized signed hosts (or an explicit `hosts` entry)
// are captured. In forced mode (`enabled: true`) an explicit `hosts` or
// `json_fields` match is honored even for an unrecognized host, since the
// author asked for it by name.
export function parseSignedConfig(raw) {
  const norm = (cfg) => ({
    enabled: cfg.enabled,
    hosts: Array.isArray(cfg.hosts) ? cfg.hosts.map((h) => String(h).toLowerCase()) : [],
    jsonFields: cfg.jsonFields && cfg.jsonFields.length ? cfg.jsonFields.map(String) : null,
  });
  if (raw === false) return { enabled: false, hosts: [], jsonFields: null };
  if (raw === true) return norm({ enabled: true });
  if (raw == null) return norm({ enabled: "auto" });
  if (typeof raw === "object") {
    const enabled =
      raw.enabled === undefined
        ? "auto"
        : raw.enabled === true
          ? true
          : raw.enabled === false
            ? false
            : "auto";
    if (enabled === false) return { enabled: false, hosts: [], jsonFields: null };
    const jsonFields = Array.isArray(raw.json_fields)
      ? raw.json_fields
      : Array.isArray(raw.jsonFields)
        ? raw.jsonFields
        : null;
    return norm({ enabled, hosts: raw.hosts, jsonFields });
  }
  return norm({ enabled: "auto" });
}

// Choose the best signed-URL candidate from the page-captured list, or null.
// `candidates` is the shape pushed by SIGNED_PAGE_HOOK:
//   [{ api_url, urls: [{ field, url }], ts }]
export function pickSignedCandidate(candidates, opts = {}) {
  const hosts = opts.hosts || [];
  const jsonFields = opts.jsonFields || null;
  for (const cand of candidates || []) {
    for (const u of cand.urls || []) {
      // json_fields only *filters* which fields are inspected — it never
      // bypasses the host check below.
      if (jsonFields && !jsonFields.includes(leafField(u.field)) && !jsonFields.includes(u.field))
        continue;
      let host = "";
      try {
        host = new URL(u.url).host.toLowerCase();
      } catch {
        continue;
      }
      const hostAllowed =
        hosts.length > 0 &&
        hosts.some((h) => host === h || host.endsWith(`.${h}`));
      const looksSigned = isSignedHost(host);
      // A host match is ALWAYS required: a recognized signed host (auto mode)
      // or an explicit `hosts` allowlist entry. Forced mode (`enabled: true`)
      // does not relax this — it only opts the feature on; an author who needs
      // an unrecognized host must name it in `hosts`. This closes the SSRF gap
      // where forced + json_fields accepted an arbitrary host.
      const accept = hostAllowed || looksSigned;
      if (accept) {
        return { url: u.url, field: u.field, api_url: cand.api_url || null, host };
      }
    }
  }
  return null;
}

// Page-side hook installed BEFORE the click. Wraps fetch + XHR to inspect small
// same-origin JSON responses and stash any http(s) URL fields. Idempotent and
// fail-open — any error in the wrapper falls through to the original call so the
// app keeps working. Mirrors the blob hook's "never uninstall" contract.
export const SIGNED_PAGE_HOOK = `(() => {
  if (window.__wbSignedInstalled) return;
  window.__wbSignedInstalled = true;
  window.__wbSignedCandidates = [];
  var MAX_BODY = 64 * 1024;
  var MAX_CAND = 50;

  var sameOrigin = function(u){
    try { return new URL(u, location.href).origin === location.origin; }
    catch (e) { return false; }
  };

  var collect = function(apiUrl, text){
    try {
      if (!text || text.length > MAX_BODY) return;
      var data;
      try { data = JSON.parse(text); } catch (e) { return; }
      var urls = [];
      var visit = function(node, fp, depth){
        if (depth > 6 || urls.length >= 30) return;
        if (typeof node === 'string') {
          if (/^https?:\\/\\//i.test(node)) urls.push({ field: fp, url: node });
          return;
        }
        if (Array.isArray(node)) {
          for (var i = 0; i < node.length; i++) visit(node[i], fp + '[' + i + ']', depth + 1);
          return;
        }
        if (node && typeof node === 'object') {
          for (var k in node) {
            if (Object.prototype.hasOwnProperty.call(node, k)) {
              visit(node[k], fp ? fp + '.' + k : k, depth + 1);
            }
          }
        }
      };
      visit(data, '', 0);
      if (urls.length && window.__wbSignedCandidates.length < MAX_CAND) {
        window.__wbSignedCandidates.push({ api_url: apiUrl, urls: urls, ts: Date.now() });
      }
    } catch (e) {}
  };

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function(){
      var args = arguments;
      var reqUrl = '';
      try { reqUrl = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || ''; } catch (e) {}
      var p = origFetch.apply(this, args);
      try {
        if (sameOrigin(reqUrl) && p && typeof p.then === 'function') {
          p.then(function(res){
            try {
              var ct = (res && res.headers && res.headers.get && res.headers.get('content-type')) || '';
              if (/json|text/i.test(ct) || ct === '') {
                res.clone().text().then(function(t){ collect(reqUrl, t); }).catch(function(){});
              }
            } catch (e) {}
            return res;
          }).catch(function(){});
        }
      } catch (e) {}
      return p;
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function(method, url){
      try { this.__wbUrl = url; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function(){
      try {
        var self = this;
        this.addEventListener('load', function(){
          try {
            if (sameOrigin(self.__wbUrl)) {
              var rt = '';
              try {
                if (self.responseType === '' || self.responseType === 'text') rt = self.responseText;
              } catch (e) {}
              if (rt) collect(self.__wbUrl, rt);
            }
          } catch (e) {}
        });
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }
})()`;

// Read-and-clear of the candidate buffer so successive polls only see new
// responses (matches the blob hook's read-and-clear contract).
export const SIGNED_POLL_SCRIPT = `(() => {
  var c = window.__wbSignedCandidates || [];
  window.__wbSignedCandidates = [];
  return c;
})()`;

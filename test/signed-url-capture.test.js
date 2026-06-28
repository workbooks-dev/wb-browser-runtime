// Tests for lib/signed-url-capture.js pure helpers — host recognition, URL
// redaction, JSON URL extraction, config parsing, and candidate selection.
// No browser, no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isSignedHost,
  redactSignedUrl,
  extractUrlFields,
  parseSignedConfig,
  pickSignedCandidate,
} from "../lib/signed-url-capture.js";

test("isSignedHost recognizes S3 / GCS / CloudFront / Azure / R2", () => {
  for (const h of [
    "bucket.s3.amazonaws.com",
    "bucket.s3.us-east-1.amazonaws.com",
    "s3.amazonaws.com",
    "s3.us-east-1.amazonaws.com",
    "s3-us-west-2.amazonaws.com",
    "storage.googleapis.com",
    "d111111abcdef8.cloudfront.net",
    "myacct.blob.core.windows.net",
    "abc123.r2.cloudflarestorage.com",
  ]) {
    assert.equal(isSignedHost(h), true, `expected signed: ${h}`);
  }
});

test("isSignedHost rejects ordinary app hosts", () => {
  for (const h of ["app.example.com", "api.pilot.com", "example.com", ""]) {
    assert.equal(isSignedHost(h), false, `expected not signed: ${h}`);
  }
});

test("redactSignedUrl strips the query but keeps origin + path", () => {
  assert.equal(
    redactSignedUrl(
      "https://bucket.s3.amazonaws.com/reports/pl.xlsx?X-Amz-Signature=deadbeef&X-Amz-Expires=30",
    ),
    "https://bucket.s3.amazonaws.com/reports/pl.xlsx?<redacted>",
  );
  assert.equal(
    redactSignedUrl("https://host/path/file.csv"),
    "https://host/path/file.csv",
  );
});

test("redactSignedUrl degrades safely on an unparseable value", () => {
  assert.equal(redactSignedUrl("not a url?token=abc"), "not a url?<redacted>");
});

test("extractUrlFields finds nested http(s) URLs with dotted paths", () => {
  const urls = extractUrlFields({
    status: "ok",
    data: { download_url: "https://x.s3.amazonaws.com/f.xlsx?sig=1" },
    files: [{ url: "https://y/z.csv" }],
    nope: "/relative/path",
    n: 5,
  });
  const byField = Object.fromEntries(urls.map((u) => [u.field, u.url]));
  assert.equal(byField["data.download_url"], "https://x.s3.amazonaws.com/f.xlsx?sig=1");
  assert.equal(byField["files[0].url"], "https://y/z.csv");
  assert.equal(Object.keys(byField).length, 2); // relative + number ignored
});

test("parseSignedConfig defaults to auto", () => {
  assert.deepEqual(parseSignedConfig(undefined), {
    enabled: "auto",
    hosts: [],
    jsonFields: null,
  });
});

test("parseSignedConfig: false disables", () => {
  assert.equal(parseSignedConfig(false).enabled, false);
  assert.equal(parseSignedConfig({ enabled: false }).enabled, false);
});

test("parseSignedConfig reads hosts + json_fields and lowercases hosts", () => {
  const cfg = parseSignedConfig({
    enabled: true,
    hosts: ["Pilot-Downloads.S3.amazonaws.com"],
    json_fields: ["download_url"],
  });
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.hosts, ["pilot-downloads.s3.amazonaws.com"]);
  assert.deepEqual(cfg.jsonFields, ["download_url"]);
});

test("pickSignedCandidate (auto) picks a recognized signed host", () => {
  const cands = [
    {
      api_url: "https://app/reports/123/download",
      urls: [
        { field: "tracking_url", url: "https://app.example.com/t" },
        { field: "download_url", url: "https://b.s3.amazonaws.com/f.xlsx?sig=1" },
      ],
    },
  ];
  const picked = pickSignedCandidate(cands, parseSignedConfig(undefined));
  assert.ok(picked);
  assert.equal(picked.url, "https://b.s3.amazonaws.com/f.xlsx?sig=1");
  assert.equal(picked.field, "download_url");
  assert.equal(picked.api_url, "https://app/reports/123/download");
});

test("pickSignedCandidate (auto) ignores non-signed hosts", () => {
  const cands = [{ urls: [{ field: "url", url: "https://app.example.com/x" }] }];
  assert.equal(pickSignedCandidate(cands, parseSignedConfig(undefined)), null);
});

test("pickSignedCandidate honors an explicit hosts allowlist for non-signed hosts", () => {
  const cands = [
    { urls: [{ field: "url", url: "https://downloads.internal.corp/f.pdf?t=1" }] },
  ];
  const cfg = parseSignedConfig({ enabled: true, hosts: ["internal.corp"] });
  const picked = pickSignedCandidate(cands, cfg);
  assert.ok(picked);
  assert.equal(picked.host, "downloads.internal.corp");
});

test("pickSignedCandidate (forced) honors json_fields match on a non-signed host", () => {
  const cands = [
    {
      urls: [
        { field: "preview", url: "https://app.example.com/preview" },
        { field: "export_href", url: "https://files.internal/x.csv?tok=9" },
      ],
    },
  ];
  const cfg = parseSignedConfig({ enabled: true, json_fields: ["export_href"] });
  const picked = pickSignedCandidate(cands, cfg);
  assert.ok(picked);
  assert.equal(picked.field, "export_href");
});

test("pickSignedCandidate (forced) without hosts/fields still requires a signed host", () => {
  const cands = [{ urls: [{ field: "url", url: "https://app.example.com/x" }] }];
  const cfg = parseSignedConfig(true);
  assert.equal(pickSignedCandidate(cands, cfg), null);
});

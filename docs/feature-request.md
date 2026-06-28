# Feature Requests

## Signed URL export capture

**Status:** SHIPPED 2026-06-27. Requested from the Pilot financial statements runbook on 2026-05-07.

Implemented as a third capture racer in the `download:` verb (`lib/signed-url-capture.js` + `verbs/download.js`):

- Page-side hook wraps `fetch`/`XHR` around the click and inspects small (<64KB) same-origin JSON responses, recursively extracting http(s) URL fields (bounded depth/count).
- Recognized object-store hosts (S3, GCS, CloudFront, Azure Blob, R2) are accepted in `auto` mode (default); `signed_url.hosts` / `signed_url.json_fields` narrow or extend selection; `signed_url: false` disables.
- The bytes are fetched **from the sidecar** via `retryableFetch` (CORS doesn't apply), saved under `path:` in `$WB_ARTIFACTS_DIR`, honoring `WB_BROWSER_DOWNLOAD_EXTENSIONS`.
- Signed query credentials are redacted everywhere they cross stdio (`provenance.signed_url = origin+path?<redacted>`); full URL stays only in memory for the fetch.
- `slice.artifact_saved` carries `capture: "signed_url"`, `api_url`, `field`, `content_type`, `content_disposition`. Failures emit `slice.download_failed` with redacted diagnostics; a 403 sets `expired: true`.
- Tests: pure helpers in `test/signed-url-capture.test.js`; verb-level capture/redaction/expiry/disable in `test/download-verb.test.js`.

Acceptance criteria met. Remaining nicety (not yet done): wiring `slice.download_skipped`-style diagnostics for the passive (non-`download:`-verb) capture path; the verb path is complete.

### Original request (for history)

### Problem

Some SaaS export buttons do not produce a Playwright `download` event or a readable in-page `Blob`. Pilot Financial Statements exposed this pattern:

1. The user clicks `Download as xlsx`.
2. The app calls a same-origin API endpoint such as `/reports/.../download`.
3. The API returns JSON: `{ "download_url": "https://...s3.amazonaws.com/...xlsx?<signed params>", "valid_for": 30 }`.
4. The app opens or navigates to that signed URL.

The workbook exists and browser navigation can download it, but page-side `fetch(signedUrl)` fails because S3/GCS/CloudFront CORS does not allow the app origin to read the bytes. In the Pilot run, the runtime did not surface a native download artifact either, so the runbook had to install custom hooks, save the full signed URL to a JSON artifact, and have a Python cell download the file server-side before expiry.

### Desired Runtime Behavior

Add signed-URL handoff support to the explicit `download` verb, and preferably to passive download capture diagnostics:

- Hook same-origin `fetch`/XHR responses around the click and inspect small JSON/text responses.
- Detect URL-looking fields such as `download_url`, `url`, `href`, `signed_url`, `file_url`, and nested equivalents.
- Recognize signed file hosts including S3, GCS, CloudFront, and provider-configured host allowlists.
- Redact signed query params in stdout/events, but keep the full URL only in runtime memory while downloading.
- Download the signed URL from the sidecar process, not from page JavaScript, so CORS does not apply.
- Save the result under the requested `path` inside `$WB_ARTIFACTS_DIR`, honoring `WB_BROWSER_DOWNLOAD_EXTENSIONS`.
- Emit the same `slice.artifact_saved` shape as other downloads, with provenance like:
  - `capture: "signed_url"`
  - source API URL
  - redacted signed URL
  - content type / disposition
  - expiry when available
- On failure, emit `slice.download_failed` with redacted diagnostics: API response status/type, detected URL fields, sidecar fetch status, and whether the signed URL expired.

### API Sketch

Existing usage should keep working:

```yaml
- download:
    selector: 'button:has-text("Download as xlsx")'
    path: pilot-profit-loss.xlsx
    timeout: 10s
```

Optional controls for stricter capture:

```yaml
- download:
    selector: 'button:has-text("Download as xlsx")'
    path: pilot-profit-loss.xlsx
    timeout: 10s
    signed_url:
      enabled: true
      hosts:
        - pilot-report-downloads.s3.amazonaws.com
      json_fields:
        - download_url
```

Default behavior can be `enabled: "auto"` for JSON responses from same-origin URLs whose request URL or response headers look export-related.

### Acceptance Criteria

- A test page that returns JSON with a pre-signed/file URL is captured by `download:` without custom runbook JavaScript.
- Sidecar fetch succeeds even when page-side fetch would fail because of CORS.
- Signed URLs are never printed with query credentials in stdout/stderr/events.
- Expired or blocked URLs fail within the verb timeout and emit actionable `slice.download_failed` diagnostics.
- Existing Playwright download and in-page Blob tests continue to pass.

### Pilot Evidence

Pilot Financial Statements produced a JSON response with `download_url` and `valid_for: 30`. The runbook workaround collected all three XLSX exports by saving the signed URL in a capture artifact and downloading it in the next Python cell; source metadata reported `pilot_signed_download_url`.

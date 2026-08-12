# Local configuration UI contract

Status: v1 proposal

`uni-push config ui` starts a short-lived local configuration application. It
is a browser client for the CLI's existing configuration, validation, doctor,
dry-run, and send services—not a second implementation of those rules.

## Boundary and lifecycle

V1 binds an operating-system-assigned port on the numeric IPv4 loopback address
`127.0.0.1` only. It never binds `0.0.0.0`, a LAN address, a hostname, or a Unix
socket exposed through another server. Loopback HTTP is acceptable for this
local process boundary; the application makes no remote request.

The CLI creates a cryptographically random 256-bit, single-use bootstrap token
and attempts to open the system browser at:

```text
http://127.0.0.1:{port}/#bootstrap={base64url-token}
```

The fragment is not sent in the HTTP request. Bundled JavaScript immediately
removes it from the visible URL with `history.replaceState` and exchanges it at
`/api/v1/bootstrap`. The bootstrap expires after 60 seconds and cannot be
reused. The returned 256-bit session token is retained only in memory and sent
as `Authorization: Bearer ...` on API requests. The page never uses cookies,
`localStorage`, `sessionStorage`, IndexedDB, or service workers. Reloading
requires a new session.

If the browser cannot be opened, or `--no-open` is used, the CLI prints the
base URL and an eight-digit, single-use pairing code. The code expires after
120 seconds, permits five attempts, and is exchanged at `/api/v1/pair` for an
in-memory session token. The full bearer token is never printed.

The server accepts one active browser session. It shuts down after 10 minutes
without an authenticated API request, after a 60-minute absolute lifetime, on
explicit shutdown, or when the parent CLI terminates. Shutdown clears session,
pairing, confirmation, draft, and rollback material from memory.

`config ui` is human-interactive and rejects `--json`; an Agent should use the
versioned CLI inspection commands instead.

## HTTP security

Every request must have the exact expected `Host` value
`127.0.0.1:{assigned-port}`. API requests other than bootstrap and pairing
require the bearer token. State-changing requests additionally require:

- exact `Origin: http://127.0.0.1:{assigned-port}`;
- `Content-Type: application/json` with no form fallback;
- `Sec-Fetch-Site: same-origin` or `none` when the header is present;
- an allowed method and route; redirects and method overrides are unsupported.

The server emits no CORS allow-origin header. It rejects unexpected `Origin`,
`Host`, `Forwarded`, and `X-Forwarded-*` values and never trusts proxy headers.
Authentication, bootstrap, and pairing comparisons are constant-time where
applicable.

All HTML and API responses use `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cross-Origin-Opener-Policy: same-origin`, and a restrictive
`Permissions-Policy`. The HTML response uses:

```text
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self';
  img-src 'self' data:;
  connect-src 'self';
  base-uri 'none';
  form-action 'none';
  frame-ancestors 'none';
  object-src 'none'
```

JavaScript and CSS are separate bundled assets. There are no inline handlers,
remote assets, analytics, telemetry, source maps, WebSockets, iframes, plugins,
or dynamically evaluated code. Configuration and diagnostic strings are
inserted with DOM text/value APIs, never `innerHTML`; URL attributes are not
constructed from configuration values.

Pairing bodies are limited to 1 KiB, test requests to 64 KiB, and configuration
requests to 512 KiB. Oversized bodies are rejected before JSON parsing. Request
bodies, bearer tokens, secret updates, config values, and provider replies are
never logged.

## Page structure

The application is a single responsive page with five sections:

1. **Overview** — server lifetime, active configuration status, validation
   summary, doctor action, and unsaved-change state.
2. **Connections** — provider-specific connection forms and secret storage.
3. **Channels** — redacted destination forms linked to connections.
4. **Targets** — ordered channel routing with single, fallback, or broadcast
   policy.
5. **Test** — message preview, dry-run plan, and separately gated real test.

The first four sections edit one in-memory draft. Provider forms expose only
fields from `config.v1.schema.json`. Reordering target channels is explicit and
keyboard accessible. Every input has a visible label; errors are linked to the
field, announced through an ARIA live region, and never indicated by color
alone. V1 uses plain bundled HTML, CSS, and JavaScript without a framework.

Secret-reference fields may show `env:VARIABLE` or
`keychain:service/account`, but resolved secret values are never returned by the
server. Existing secrets display as configured/missing/unchecked status. A new
keychain value uses a password input, is kept only until the save response, and
is immediately cleared from the DOM state afterward.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/` and `/assets/*` | Bundled static application; no API data. |
| `POST` | `/api/v1/bootstrap` | Exchange the auto-open fragment token once. |
| `POST` | `/api/v1/pair` | Exchange the fallback pairing code once. |
| `GET` | `/api/v1/session` | Return remaining idle and absolute lifetime. |
| `GET` | `/api/v1/config` | Return one config snapshot, secret references only, and an opaque revision. |
| `POST` | `/api/v1/config/validate` | Validate a submitted config draft without secret or network access. |
| `PUT` | `/api/v1/config` | Save a validated revision and optional keychain updates. |
| `POST` | `/api/v1/test/prepare` | Run dry-run and create a short-lived confirmation. |
| `POST` | `/api/v1/test/confirm` | Consume confirmation and perform exactly one real send. |
| `POST` | `/api/v1/shutdown` | Stop the local server. |

Owned request and response envelopes are defined in
[`schemas/config-ui-api.v1.schema.json`](../schemas/config-ui-api.v1.schema.json).
Validation responses use the `config_validate` branch of
[`inspection-result.v1.schema.json`](../schemas/inspection-result.v1.schema.json).
Test preparation embeds a
[`dry-run-result.v1`](../schemas/dry-run-result.v1.schema.json), and test
confirmation returns a
[`delivery-receipt.v1`](../schemas/delivery-receipt.v1.schema.json).

The server returns JSON errors with stable codes and no free-form provider or
exception text. Relevant HTTP statuses are `400` invalid input, `401` invalid or
expired session, `403` rejected Host/Origin/fetch context, `409` revision or
confirmation conflict, `413` body too large, `429` pairing throttled, and `500`
for sanitized internal failures.

## Configuration revision and save

The UI edits exactly the configuration path resolved when the CLI starts. The
page never receives that absolute path. V1 refuses to edit a symlink, directory,
device, or other non-regular target. A new file may be created only inside an
existing user-writable directory.

`GET /api/v1/config` returns an opaque SHA-256 revision derived from the exact
file snapshot. Validate and save requests carry that revision. A mismatch is
`revision_conflict`; the server never overwrites external edits. The user must
reload and consciously reapply changes.

Save is serialized under an exclusive lock and follows this order:

1. Recheck revision, request schema, cross-references, secret-update references,
   and all provider-static rules.
2. Serialize the normalized config into a same-directory temporary file with
   mode `0600`, flush it, and prepare one same-directory recoverable backup.
3. Apply requested keychain changes while retaining previous values only in
   process memory for rollback.
4. Atomically replace the configuration, flush the containing directory, and
   publish the new revision.
5. Clear new and rollback secret material from memory and keep exactly one
   previous config backup with mode `0600`.

If a keychain update fails, the config is not replaced and prior keychain
values are restored. If config replacement fails, keychain changes are rolled
back. A rollback failure returns `recovery_required`, stops the UI, preserves
the previous config and backup, and requires human inspection. The server never
claims a transaction succeeded unless config and requested keychain updates are
both committed.

Only `keychain:` references present in the submitted configuration can receive
a keychain update, and each reference may appear at most once per request.
Environment references never accept a secret value through the UI; the page
instructs the user to set that variable outside Uni Push.

## Test preview and confirmation

Test preparation runs the exact `send --dry-run` service. It does not resolve
secrets, access the network, mutate the ledger, or send. If ready, the server
stores the complete request only in memory and returns a 256-bit confirmation
ID, its request fingerprint, the dry-run plan, and a 60-second expiry.

The page must display the title, body, selected destination, resolved policy,
planned channels, and a prominent warning for broadcast before enabling the
real-send button. This content comes from the page's own request plus the
redacted plan; it is not echoed by the backend response.

Confirmation requires a fresh user click after preparation. The request sends
only the confirmation ID, matching fingerprint, and `confirmed: true`. The ID
is single-use, bound to the session, config revision, and exact in-memory send
request, and expires after 60 seconds. Editing the draft or test message
invalidates it. The backend consumes it before dispatch so double-clicks cannot
send twice; the notification ID and normal ledger still provide replay safety.

Expired, reused, mismatched, or stale-revision confirmations never send. Once
dispatch begins, the endpoint returns the normal accepted, rejected, uncertain,
or partial delivery receipt and never retries on browser disconnect.

## Primary standards references

- [RFC 8252 loopback-interface pattern](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)
- [RFC 6454 — Web Origin Concept](https://www.rfc-editor.org/rfc/rfc6454)
- [Content Security Policy Level 3](https://www.w3.org/TR/CSP3/)
- [Fetch Metadata Request Headers](https://www.w3.org/TR/fetch-metadata/)

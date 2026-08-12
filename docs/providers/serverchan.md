# ServerChan adapter contract

Status: v1 proposal

The ServerChan adapter supports both Server酱 Turbo (SCT) and Server酱³ (SC3).
It implements the provider protocol inside `uni-push-cli`; it does not invoke a
second Agent Skill at runtime.

## Upstream reference

Endpoint selection and provider fields are based on the MIT-licensed official
projects maintained by `easychen`:

- <https://github.com/easychen/serverchan-skill>
- <https://github.com/easychen/serverchan-sdk>

The contract was reviewed against `serverchan-skill` commit
`b2815a700e1b8fa7308900cf461cd1b15ca72ee2` and `serverchan-sdk` commit
`767d36645e53fb9ddeeea37de9c604770732e727`.

If implementation code is copied rather than independently written, the CLI
repository must retain the upstream MIT copyright and license notice.

## SendKey classification

The adapter resolves the configured secret reference immediately before use
and classifies it without logging its value:

| SendKey form | Edition | Endpoint |
| --- | --- | --- |
| `SCT...` | Server酱 Turbo | `https://sctapi.ftqq.com/{sendkey}.send` |
| `sctp<num>t...` | Server酱³ | `https://<num>.push.ft07.com/send/{sendkey}.send` |

`<num>` must contain ASCII digits only and is extracted from the anchored SC3
prefix. An unknown prefix or malformed SC3 key is a pre-dispatch
`configuration_error`. It must not fall through to the SCT endpoint.

Because the SendKey appears in the URL path, the complete URL is sensitive.
The adapter must never include it in logs, exceptions, receipts, tracing span
names, HTTP debug output, or configuration diagnostics.

## Request mapping

The adapter sends a JSON POST request with
`Content-Type: application/json;charset=utf-8`.

| Uni Push field | Provider field | Rule |
| --- | --- | --- |
| `message.title` | `title` | Required and unchanged. |
| `message.body` | `desp` | Plain text or Markdown. |
| `message.summary` | `short` | Included when present; supported by SCT and SC3. |
| `message.tags` | `tags` | SC3 only; join with `\|`. |
| `message.url` | `desp` | Append after a blank line and report `url_appended_to_body`. |
| channel `delivery_channels` | `channel` | SCT only; join with `\|`. |
| channel `hide_caller_ip` | `noip` | SCT only; send integer `1` when true. |

Only the fields in this table may be submitted. Provider-specific options
cannot override `title` or `desp`.

When SCT receives message tags, the adapter omits them and reports
`tags_omitted`. Configuring SCT-only channel options for an SC3 SendKey is a
pre-dispatch `configuration_error`; the adapter does not silently ignore those
options.

## Transport boundary

The request uses the shared injectable HTTP transport with these v1 limits:

- HTTPS only;
- redirects disabled;
- 3-second connection timeout;
- 8-second total timeout;
- 64 KiB maximum response body;
- no automatic retry inside the adapter.

The transport must distinguish a failure before request-body dispatch from a
failure after dispatch may have begun. This distinction prevents an automatic
fallback from producing duplicate notifications.

## Response mapping

| Observation | Attempt status | Reason |
| --- | --- | --- |
| HTTP 2xx, JSON object, integer `code` equals `0` | `accepted` | `provider_accepted` |
| HTTP 429 observed | `rejected` | `rate_limited` |
| Other HTTP non-2xx response observed | `rejected` | `transport_rejected` |
| HTTP 2xx, valid response with nonzero `code` | `rejected` | `provider_rejected` |
| Invalid or oversized response after dispatch | `uncertain` | `malformed_response` |
| Timeout after dispatch may have begun | `uncertain` | `timeout_after_send` |
| Other connection loss after dispatch may have begun | `uncertain` | `transport_ambiguous` |
| Failure proven to occur before dispatch | `rejected` | `transport_rejected` |

`accepted` has `provider_api_only` scope. No claim is made about downstream
WeChat/App delivery or human acknowledgement. Raw provider responses are never
copied into the receipt.

## Diagnostics and configuration UI

`config validate` checks only configuration shape and references. `doctor` may
resolve the SendKey, classify its edition, validate compatible channel options,
and check DNS/TLS reachability. It cannot prove that a SendKey is accepted
without sending a notification, so it must not report credential validity.

The HTML configuration assistant shows only a redacted classification such as
`Server酱³ (sctp…)`. It never returns a stored SendKey to the browser. A real
test notification remains an explicit, confirmed side effect.

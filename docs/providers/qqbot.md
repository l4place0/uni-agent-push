# QQ Bot adapter contract

Status: implemented MVP

The QQ Bot adapter sends proactive notifications to a preconfigured QQ group
or user OpenID through the official QQ Bot OpenAPI. QQ channel/guild messages,
passive replies, event subscriptions, inbound messages, keyboards, and media
uploads are outside the v1 boundary.

## Authoritative references

This contract was reviewed on 2026-08-11 against the current official QQ Bot
documentation:

- Authentication: <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>
- Message overview: <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- Group messages: <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>
- Direct messages: <https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html>
- Markdown: <https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html>

The official `tencent-connect/botgo` SDK is useful as a model reference, but
its latest repository commit at review time still used the historical
`api.sgroup.qq.com` domain. The dated SDK constant is not authoritative for the
v1 endpoint.

## Migration note

Earlier implementations, including the user-provided `push-staff-alert`, used
`https://bots.qq.com/app/getAppAccessToken` and
`https://api.sgroup.qq.com`. The current official documentation uses
`https://api.bot.qq.com` for both token and OpenAPI calls. The adapter must not
retain the historical endpoints or provide a configurable endpoint override.

## Configuration and targets

A connection contains a non-secret App ID and a secret reference for the client
secret. A channel identifies exactly one preconfigured target:

```yaml
connections:
  qq-main:
    provider: qqbot
    app_id: "100000000"
    client_secret: keychain:uni-push/qq-main

channels:
  qq.team:
    provider: qqbot
    connection: qq-main
    target:
      type: group
      openid: opaque-group-openid

  qq.owner:
    provider: qqbot
    connection: qq-main
    target:
      type: user
      openid: opaque-user-openid
```

An OpenID is an opaque platform identifier, not a QQ number or group number.
The CLI and HTML configuration assistant reject an all-digit target to reduce
accidental use of raw QQ identifiers. They never enumerate users or groups.

All v1 sends are proactive messages: the adapter does not include `msg_id`,
`event_id`, `msg_seq`, or `is_wakeup`. The target relationship must allow
proactive messages; a user or group administrator can disable them in QQ.

## Authentication

Before message dispatch, POST JSON to:

```text
https://api.bot.qq.com/app/getAppAccessToken
```

```json
{
  "appId": "APP_ID",
  "clientSecret": "CLIENT_SECRET"
}
```

A successful response contains a non-empty `access_token` and positive
`expires_in`. The official example encodes `expires_in` as a string even though
the field table describes a number, so the adapter accepts a positive integer
or a decimal string and normalizes it to seconds.

The token is cached in memory per process and refreshed no later than 60 seconds
before expiry. Concurrent sends for one connection share a single token fetch.
Tokens are never persisted to the idempotency ledger or configuration files.

OpenAPI requests use:

```text
Authorization: QQBot ACCESS_TOKEN
```

Token acquisition is before message dispatch. A token timeout, malformed token
response, or rejected credential is therefore a definitive `rejected` attempt,
not an `uncertain` message delivery.

## Message endpoints

| Target | Endpoint |
| --- | --- |
| `group` | `POST https://api.bot.qq.com/v2/groups/{group_openid}/messages` |
| `user` | `POST https://api.bot.qq.com/v2/users/{user_openid}/messages` |

The OpenID is percent-encoded as one path segment. Redirects are disabled.

## Request mapping

QQ has no separate title field. The adapter renders one outbound document:

- plain: `{title}\n\n{body}` with `msg_type: 0` and `content`;
- Markdown: `## {escaped title}\n\n{body}` with `msg_type: 2` and
  `markdown.content`.

When `message.url` is present, it is appended after a blank line and the receipt
reports `url_appended_to_body`. Both formats report
`title_prefixed_to_body`. `message.summary` and `message.tags` are omitted and
reported as `summary_omitted` and `tags_omitted` when present.

The adapter uses native custom Markdown content. It does not use deprecated
template IDs. The official documentation states that custom Markdown for QQ
group and direct messages has been available to all bots since 2026-04-23.
Provider rejection of Markdown or URLs is returned to the caller; the adapter
does not make a second plain-text send automatically.

## Proactive-message limits

The provider currently documents the following relevant relationship limits:

- 20 messages per minute per user or group relationship;
- 1,000 messages per day per user or group;
- bot-wide limits depend on target type and bot verification status.

These limits may change and are not used as permanent local constants. The
adapter maps observed provider rate-limit responses to `rate_limited` and does
not retry automatically. The HTML assistant describes these as provider-owned
limits rather than guaranteed quotas.

## Transport boundary

Token and message requests use the shared injectable HTTPS transport:

- redirects disabled;
- 3-second connection timeout;
- 8-second total timeout;
- 64 KiB maximum response body;
- no automatic retry;
- no logging of credentials, access tokens, Authorization headers, OpenIDs,
  message content, or raw provider responses.

The transport marks the start of message-body dispatch separately from token
acquisition so fallback behavior remains duplicate-safe.

## Response mapping

A successful message response is an HTTP 2xx JSON object with a non-empty
string `id`. `timestamp` may be retained only in internal diagnostics; neither
field is required in the sanitized v1 receipt.

| Observation | Attempt status | Reason |
| --- | --- | --- |
| HTTP 2xx with non-empty message `id` | `accepted` | `provider_accepted` |
| Token endpoint rejects credentials | `rejected` | `authentication_rejected` |
| HTTP 401 or 403 from message endpoint | `rejected` | `authentication_rejected` |
| HTTP 429 or QQ rate-limit error | `rejected` | `rate_limited` |
| Bot is not a target member or OpenID is unusable | `rejected` | `invalid_target` |
| Content, Markdown, URL, or length is rejected | `rejected` | `unsupported_content` |
| Other structured provider error | `rejected` | `provider_rejected` |
| Failure proven before message dispatch | `rejected` | `transport_rejected` |
| Timeout after message dispatch may begin | `uncertain` | `timeout_after_send` |
| Connection loss after message dispatch may begin | `uncertain` | `transport_ambiguous` |
| HTTP success with malformed/oversized response | `uncertain` | `malformed_response` |

Relevant current QQ errors include `40034100` for proactive-message rate limit,
`40034101`/`40054003` for a bot not in the group, and
`40034006`/`40054007`/`40054010` for rejected content, length, or URLs. The
implementation maps these codes into the stable reasons above and never exposes
their raw response text.

`accepted` has `provider_api_only` scope. It does not assert client display,
human receipt, or acknowledgement.

## Diagnostics and configuration UI

`config validate` verifies shape and cross-references without resolving the
client secret. `doctor` may resolve credentials and call the token endpoint,
because token acquisition does not send a notification. It reports only a
sanitized credential status and token expiry duration.

The HTML assistant:

- stores the client secret through a private local-store or environment reference;
- labels group and user OpenIDs as opaque values, not QQ numbers;
- explains that v1 sends proactive messages and requires recipient permission;
- previews title/body rendering and omitted fields;
- requires explicit confirmation before a real test notification.

When an OpenID is unknown, the UI explicitly routes the user through target
acquisition: enable the applicable group/C2C event, connect the Bot's WebSocket
Gateway or Webhook, interact with the Bot, and extract the group or user OpenID
from the inbound event. OpenIDs are scoped to the Bot AppID. The MVP does not
claim that AppID/AppSecret can enumerate targets and does not embed an inbound
QQ event receiver; an Agent may help inspect an existing receiver or propose a
bounded temporary receiver as a separate setup step.

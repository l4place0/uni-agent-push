# Telegram Bot adapter contract

Status: implemented MVP

The Telegram adapter sends proactive text notifications with the official
Telegram Bot API `sendMessage` method. Version 1 excludes media, files, inline
keyboards, replies, business connections, paid broadcasts, direct-message
topics, ephemeral messages, and a self-hosted Bot API server.

## Authoritative references

This contract was reviewed on 2026-08-11 against Telegram Bot API 10.2:

- Bot API and request protocol: <https://core.telegram.org/bots/api>
- `sendMessage`: <https://core.telegram.org/bots/api#sendmessage>
- Formatting options: <https://core.telegram.org/bots/api#formatting-options>
- Bot FAQ rate limits: <https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this>

## Configuration and targets

A connection stores only a secret reference for the Bot Token. A channel stores
one fixed chat target plus optional delivery behavior:

```yaml
connections:
  telegram-main:
    provider: telegram
    token: keychain:uni-push/telegram-main

channels:
  telegram.team:
    provider: telegram
    connection: telegram-main
    chat_id: "-1001234567890"
    disable_link_preview: true
    protect_content: true

  telegram.topic:
    provider: telegram
    connection: telegram-main
    chat_id: "-1001234567890"
    message_thread_id: 42
```

`chat_id` is a decimal chat identifier stored as a string, or a public
supergroup/channel username beginning with `@`. A numeric string avoids JSON
number precision loss. A user must first contact a bot before the bot can send
them private notifications; a bot must be present and permitted to post in a
group or channel.

The send adapter never accepts a dynamic `chat_id` from an Agent request.
Onboarding has a separate, read-only pending-update discovery path described
below; it does not acknowledge or persist updates.

## Bot Token and endpoint

After resolving the secret reference, the adapter validates the conventional
Bot Token form `<decimal bot id>:<URL-safe secret>`. Requests are JSON POSTs to:

```text
https://api.telegram.org/bot{token}/sendMessage
```

The token appears in the URL path, so the complete URL is sensitive. It must
never appear in logs, exceptions, receipts, tracing span names, HTTP debug
output, or the HTML configuration view. Redirects are disabled and the API
hostname is not configurable in v1.

## Request mapping

Telegram has no separate title field in `sendMessage`. The adapter renders one
`text` field and always reports `title_prefixed_to_body`.

### Plain input

For `message.format: plain`:

```text
{title}

{body}
```

No `parse_mode` is sent.

### Markdown input

The MVP sends generic Markdown as visible plain text without `parse_mode` and
reports `markdown_rendered_as_plain`. This avoids treating CommonMark as
Telegram MarkdownV2. A future renderer may add a strict HTML conversion.

### Common fields

- `message.url` is appended after a blank line and reports
  `url_appended_to_body`.
- `message.summary` and `message.tags` are omitted and report
  `summary_omitted` and `tags_omitted` when present.
- `disable_link_preview: true` maps to
  `link_preview_options: {"is_disabled": true}`.
- `silent: true` maps to `disable_notification: true`.
- `protect_content: true` maps to the same provider field.
- `message_thread_id` is sent only when configured.
- Message priority is used by Uni Push routing and is not silently mapped to
  Telegram sound behavior.

The adapter calculates the visible text length after entity parsing. Telegram
documents a limit of 1 through 4096 characters; v1 never truncates or splits a
notification. An oversized rendering is rejected before dispatch with
`unsupported_content`.

## Rate limits

Telegram's official FAQ advises:

- avoid more than one message per second in a single chat;
- groups are limited to 20 messages per minute;
- free bulk broadcasts are limited to roughly 30 messages per second.

Uni Push v1 does not implement paid broadcasts and never sends
`allow_paid_broadcast`. Provider rate limits are not hard-coded as guarantees.
An observed flood-control response maps to `rate_limited`, and a sanitized
`parameters.retry_after` may be returned as `retry_after_seconds`. The adapter
does not sleep and retry automatically.

## Transport boundary

`sendMessage`, `getMe`, `getChat`, `getWebhookInfo`, and `getUpdates` use the
shared injectable HTTPS transport:

- redirects disabled;
- 3-second connection timeout;
- 8-second total timeout;
- 64 KiB maximum response body;
- no automatic retry;
- no logging of Bot Tokens, full request URLs, Chat IDs, message content, or raw
  provider responses.

The transport marks when the `sendMessage` request body may have begun dispatch.
Calls to `getMe` and `getChat` are diagnostic and never count as message
dispatch.

## Response mapping

Telegram responses contain Boolean `ok`. Successful `sendMessage` responses
also contain a `result` Message with integer `message_id`.

| Observation | Attempt status | Reason |
| --- | --- | --- |
| HTTP 2xx, `ok: true`, integer `result.message_id` | `accepted` | `provider_accepted` |
| HTTP 401 | `rejected` | `authentication_rejected` |
| HTTP 403 or a structured unavailable-chat error | `rejected` | `invalid_target` |
| HTTP 429 or structured flood control | `rejected` | `rate_limited` |
| Entity parse error or message too long | `rejected` | `unsupported_content` |
| Other HTTP response with `ok: false` | `rejected` | `provider_rejected` |
| Failure proven before message dispatch | `rejected` | `transport_rejected` |
| Timeout after message dispatch may begin | `uncertain` | `timeout_after_send` |
| Connection loss after message dispatch may begin | `uncertain` | `transport_ambiguous` |
| HTTP success with malformed/oversized response | `uncertain` | `malformed_response` |

Telegram documents `error_code` as subject to change, so stable mapping uses a
combination of HTTP status, response structure, and carefully bounded error
classification. Raw `description` is not exposed to the Agent.

`accepted` has `provider_api_only` scope. It does not assert client display,
notification sound, human receipt, reading, or acknowledgement.

Telegram may return `parameters.migrate_to_chat_id` after a group migration.
Because Chat IDs are excluded from receipts, the adapter returns
`invalid_target`; a human can use `doctor` or the configuration UI to replace
the configured target.

## Diagnostics and configuration UI

When the Chat ID is unknown, Onboarding can perform a privacy-minimized target
discovery. It first calls `getWebhookInfo`; an active webhook blocks long
polling and is never disabled. Otherwise it calls `getUpdates` without an
offset, so the discovery does not acknowledge updates, extracts only Chat ID
and type, verifies candidates through `getChat`, and discards names and message
content. The user must first start the Bot or mention it in the target group.

`config validate` checks the token reference, Chat ID shape, thread identifier,
and cross-references without resolving the token.

`doctor` may safely call:

- `getMe`, to validate the Bot Token and obtain a redacted bot identity;
- `getChat`, to validate that the configured target is visible to the bot.

Neither call sends a message. Chat titles, usernames, member data, and raw API
responses are not persisted or logged.

The HTML assistant previews the rendered text and final character count. It
shows whether a message will be silent, protected, posted to a topic, or have
link previews disabled. A real test notification requires explicit confirmation.

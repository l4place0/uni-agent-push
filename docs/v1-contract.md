# Uni Push v1 contract

Status: proposal for review

This document freezes the boundary between the independently versioned
`uni-push-skill` and `uni-push-cli` repositories. The schemas and executable
implementation in this repository are owned by the CLI.

## Product boundary

Uni Push is an outbound notification layer for agents. An agent chooses a
preconfigured logical destination and supplies notification content. The CLI
resolves channels, applies a deterministic delivery policy, calls providers,
and returns a sanitized machine-readable receipt.

Version 1 includes:

- logical targets and explicitly named configured channels;
- QQ Bot, Telegram Bot, ServerChan, and SMTP adapters;
- `single`, `fallback`, and `broadcast` policies;
- plain-text and Markdown input;
- local idempotency and sanitized delivery receipts;
- a loopback-only HTML configuration assistant.

Version 1 excludes inbound messages, conversations, arbitrary webhook URLs,
OAuth, attachments, interactive cards, scheduling, a persistent job queue,
multi-user administration, and a hosted control plane.

## Primary flow

1. The agent resolves the user's intent into a configured destination.
2. The agent calls `uni-push send` with a versioned JSON request.
3. The CLI validates the complete request before any outbound side effect.
4. The CLI claims the `notification_id` in its local idempotency ledger.
5. The router selects configured channels in declared order.
6. Adapters attempt delivery according to the selected policy.
7. In `--json` mode, the CLI emits exactly one JSON receipt on stdout and keeps
   stderr empty for every normally handled outcome.

## Send request

The normative schema is
[`schemas/send-request.v1.schema.json`](../schemas/send-request.v1.schema.json).

`destination` is either a logical target such as `owner` or an explicitly
configured channel such as `telegram.team`. It is never a raw email address,
chat ID, OpenID, endpoint, or credential.

`notification_id` is supplied by the caller. Reusing it with the exact same
canonical request returns the stored receipt. Reusing it with different
content, destination, or policy returns `notification_conflict` without
sending.

Canonicalization, request and route fingerprints, per-notification locking,
durable attempt markers, crash recovery, retention, and capacity behavior are
defined by the normative
[`idempotency ledger contract`](idempotency-ledger.md). In particular, a crash
after a durable dispatch marker is recovered as `uncertain`, never by retrying
that channel.

Markdown is source content, not a promise that every provider renders the same
syntax. An adapter may safely convert Markdown to plain text and must report
that transformation in its attempt receipt. Version 1 never silently truncates
content.

The CLI interface is expected to support both flags and stdin JSON:

```bash
uni-push send \
  --to owner \
  --notification-id build-2026-08-11.1 \
  --title "Build complete" \
  --body "Artifact is ready." \
  --priority normal \
  --json

uni-push send --request request.json --json
```

## Delivery policy

Policies operate on the ordered channel list resolved from the destination:

- `single`: attempt only the first enabled channel.
- `fallback`: continue after a definitive `rejected` result and stop after
  `accepted` or `uncertain`.
- `broadcast`: attempt every enabled channel, including after `accepted`,
  `rejected`, or `uncertain` results.

`uncertain` means the transport may have submitted the message but no safe
provider acknowledgement was observed. Automatically falling back after that
state could duplicate a notification, so v1 does not provide an override.

For a logical target, its configured policy is the CLI flag-mode default. An
explicit request policy overrides that default. The resolved policy is included
in the canonical request before its fingerprint is calculated, so an exact
replay cannot silently use a changed target default.

Provider authentication and token acquisition happen before message dispatch.
Failures in those phases are definitive `rejected` results. A timeout or
connection loss after dispatch begins is `uncertain`.

## Delivery receipt

The normative schema is
[`schemas/delivery-receipt.v1.schema.json`](../schemas/delivery-receipt.v1.schema.json).

Process exit codes, stream ownership, input precedence, interruption behavior,
and dry-run guarantees are defined by the normative
[`CLI process contract`](cli-contract.md).

Top-level status is computed as follows:

| Status | Meaning |
| --- | --- |
| `accepted` | At least one required attempt was accepted and there is no mixed broadcast outcome. |
| `rejected` | Every attempted channel definitively rejected before provider acceptance. |
| `uncertain` | No attempt was accepted and at least one attempt may have submitted a message. |
| `partial` | A broadcast produced a mixture of accepted, rejected, or uncertain outcomes. |
| `error` | Validation, idempotency, ledger, or other pre-dispatch processing failed. |

Acceptance scope belongs to each attempt because a broadcast may mix API and
SMTP channels. `provider_api_only` means an upstream provider API accepted the
request. `smtp_relay_only` means the configured SMTP relay accepted the message
after `DATA`. Neither means device or final-mailbox delivery, human receipt,
reading, or acknowledgement.

Receipts contain no message title or body, target identifiers, credentials,
authorization data, provider URLs, or raw provider responses. Provider-specific
details are mapped into a small stable reason taxonomy.

## Configuration

The normative schema is
[`schemas/config.v1.schema.json`](../schemas/config.v1.schema.json).

Configuration separates reusable authenticated connections from channel
destinations:

- a QQ Bot connection can back several QQ group or user channels;
- a Telegram Bot connection can back several chat channels;
- an SMTP connection can back several recipient lists;
- a ServerChan connection normally backs one personal channel.

ServerChan supports both Turbo (SCT) and Server酱³ (SC3). The adapter detects
the edition from the resolved SendKey and applies version-specific capabilities;
users do not configure an edition or endpoint. Its normative provider contract
is [`docs/providers/serverchan.md`](providers/serverchan.md).

Secret fields accept references only:

- `env:VARIABLE_NAME`
- `keychain:service/account`

Literal secrets are invalid. The CLI must resolve secrets only at the point of
use and must never place resolved values into normalized configuration output,
receipts, logs, or the HTML page.

JSON Schema validates the shape of each object. The CLI must additionally
perform cross-reference validation that JSON Schema cannot express over dynamic
map keys:

- every channel references an existing connection;
- channel and connection providers match;
- every target references existing, enabled channels;
- provider-specific target identifiers are valid for the selected adapter;
- no target contains the same effective endpoint more than once.

For SMTP, validation also rejects duplicate addresses across `to`, `cc`, and
`bcc` and rejects a channel whose combined recipient count exceeds 50.

QQ Bot v1 supports proactive delivery to preconfigured group and user OpenIDs;
QQ channel/guild messages and passive replies remain outside the boundary. Its
normative provider contract is
[`docs/providers/qqbot.md`](providers/qqbot.md).

Telegram v1 uses `sendMessage` for preconfigured chats and optional forum topic
IDs. Generic Markdown is rendered through a strict Telegram HTML allowlist;
media, replies, keyboards, paid broadcasts, and dynamic chat discovery remain
outside the boundary. Its normative provider contract is
[`docs/providers/telegram.md`](providers/telegram.md).

SMTP v1 submits only to a fixed authenticated relay over implicit TLS or
mandatory STARTTLS. It uses atomic pre-`DATA` recipient validation, safe MIME
construction, and attempt-level `smtp_relay_only` acceptance semantics. Its
normative provider contract is
[`docs/providers/smtp.md`](providers/smtp.md).

## Local HTML configuration assistant

`uni-push config ui` starts a short-lived local server on a random loopback
port. It is a configuration client for the same schema and validation code used
by the CLI, not a second configuration implementation.

Required behavior:

- bind only to an explicit loopback address;
- use a random per-process session token;
- reject unexpected `Host` and `Origin` values;
- serve no remote scripts, fonts, analytics, or other third-party assets;
- apply a restrictive Content Security Policy;
- expose a redacted configuration view;
- write configuration atomically and preserve one recoverable backup;
- store secrets in the OS keychain or save an environment-variable reference;
- never return an existing secret value to the browser;
- make dry-run the default testing action;
- require explicit confirmation immediately before a real test notification;
- stop after an idle timeout or an explicit page action.

The page has five sections: overview and diagnostics, connections, channels,
logical targets, and test/preview. A framework is unnecessary for v1; embedded
HTML with separately served bundled CSS and JavaScript keeps distribution and
the trust boundary small. The complete lifecycle, HTTP security, API,
optimistic concurrency, atomic-save, secret-update, and test-confirmation rules
are defined by the
[`local configuration UI contract`](config-ui-contract.md) and
[`schemas/config-ui-api.v1.schema.json`](../schemas/config-ui-api.v1.schema.json).

## CLI command surface

```text
uni-push send
uni-push targets
uni-push channels
uni-push doctor
uni-push config validate
uni-push config ui
```

`doctor` performs redacted configuration checks and safe provider connectivity
checks. It does not send a notification. `send --dry-run` resolves routing and
statically knowable content transformations without resolving secrets,
acquiring an idempotency claim, accessing the network, or writing persistent
state. Its result schema is
[`schemas/dry-run-result.v1.schema.json`](../schemas/dry-run-result.v1.schema.json).
Secret-dependent provider capabilities are explicitly marked incomplete rather
than guessed.

The versioned, redacted JSON results for `targets`, `channels`,
`config validate`, and `doctor` are defined by the
[`inspection command contract`](inspection-commands.md) and
[`schemas/inspection-result.v1.schema.json`](../schemas/inspection-result.v1.schema.json).
Inventory commands never expose provider target identifiers, and `doctor`
distinguishes passed, failed, warning, and intentionally skipped checks.

Some providers, including ServerChan, have no credential-verification operation
that is guaranteed to be side-effect free. For those providers `doctor` reports
secret availability, format, option compatibility, DNS, and TLS reachability,
but does not claim that the credential is accepted.

## Skill behavior

The Skill is deliberately thin. It should:

- require an explicit user request before a real send;
- collect destination, title, body, priority, and delivery policy;
- generate or reuse an appropriate notification ID;
- prefer configured logical targets over explicit channels;
- preview ambiguous or high-impact broadcast sends;
- invoke the CLI without exposing secrets;
- interpret `accepted`, `rejected`, `uncertain`, `partial`, and `error`
  accurately, including each attempt's acceptance scope;
- never claim human delivery based on provider acceptance.

The Skill must not implement provider HTTP calls, parse provider responses,
manage the ledger, or maintain its own configuration model.

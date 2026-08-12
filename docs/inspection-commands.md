# Inspection command contract

Status: v1 proposal

This contract covers the four read-oriented commands used by Agents and the
local configuration assistant:

```text
uni-push targets --json
uni-push channels --json
uni-push config validate --json
uni-push doctor --json
```

Their normative result shapes share
[`schemas/inspection-result.v1.schema.json`](../schemas/inspection-result.v1.schema.json).
They also follow the stream and exit rules in
[`docs/cli-contract.md`](cli-contract.md).

## Shared safety rules

Results may contain configured target, channel, and connection names because
those names are the public local routing interface. They must never contain:

- OpenIDs, chat IDs, email addresses, SMTP hosts, provider endpoints, or full
  ServerChan URLs;
- secret references or resolved secret values;
- message titles, bodies, summaries, tags, or URLs;
- raw provider replies, exception strings, certificate subjects, DNS answers,
  access tokens, or authentication headers;
- absolute configuration paths or operating-system usernames.

Arrays use deterministic ordering. Targets, channels, connections, and subjects
are ordered lexicographically by configured name. A target's `channels` retain
routing order. Provider lists and option lists are lexicographically sorted.
Issue order is severity (`error` before `warning`), then JSON Pointer, then code.
Doctor checks are ordered by scope (`configuration`, `connection`, `channel`),
subject, and the check order defined below.

All four commands load one immutable configuration snapshot. They do not write
configuration, mutate the ledger, or send notifications.

## `targets`

`targets` returns only logical destinations. Each item exposes its routing
policy, ordered configured channel names, and unique provider types. It does not
expand provider target identifiers or connection data.

An empty `targets` array is a successful result. If configuration cannot be
loaded or is invalid, the command returns a structured `error` and exit `21`;
it never returns a partial target list.

## `channels`

`channels` returns explicitly addressable configured channel names. It exposes
only the provider, redacted delivery shape, accepted input formats, acceptance
scope, and a bounded list of non-secret behavioral options.

Delivery shape distinguishes useful routing characteristics such as QQ group
versus user, Telegram topic versus ordinary chat, and SMTP recipient list. It
never includes the underlying identifier or recipient count. `formats` means
the adapter accepts Uni Push input in that format; it does not promise native
provider rendering.

An empty `channels` array is successful. Invalid configuration produces an
error rather than a partial inventory.

## `config validate`

Validation performs no secret resolution and no network access. It covers JSON
parsing, schema version and shape, dynamic-map cross-references, provider
matching, effective-endpoint duplication, SMTP recipient rules, and statically
knowable provider-option compatibility.

`status: valid` may include warnings but cannot include an error issue and exits
`0`. `status: invalid` contains at least one error issue and exits `21`.
Unreadable or missing input is `configuration_unavailable`; CLI misuse remains
`invalid_cli_usage` with exit `20`.

Each issue contains only a stable code and an RFC 6901-style JSON Pointer. The
pointer identifies a configuration field but never embeds its value. Human mode
may render explanatory text; JSON consumers map the stable code themselves.

Because ServerChan edition is derived from the secret SendKey, validation
cannot prove SCT/SC3 option compatibility without secret access. That check is
deferred to `doctor` and real send rather than guessed.

## `doctor`

`doctor` is diagnostic and may resolve configured secrets and perform bounded
read-only network operations. It never sends a provider message and never uses
SMTP `MAIL FROM`, `RCPT TO`, or `DATA`.

Provider behavior is fixed:

| Provider | Authentication check | Target check |
| --- | --- | --- |
| QQ Bot | Acquire an app access token. | Skipped because proactive target validation would require sending. |
| Telegram | Call `getMe`. | Call `getChat` for each configured channel. |
| ServerChan | Validate SendKey form and check DNS/TLS. | Authentication and target access are skipped because no guaranteed side-effect-free send-key verification exists. |
| SMTP | Establish verified TLS, `EHLO`, and authenticate once. | Skipped because v1 doctor never issues envelope commands. |

Every network operation uses the provider contract's timeout and redirect
rules. Authentication attempts are not retried. Checks that would produce an
outbound notification are `skipped / side_effect_not_allowed`, not `passed`.

The check order is `configuration`, `secret_availability`, `secret_format`,
`option_compatibility`, `dns`, `tls`, `authentication`, `target_access`.
Dependent checks become `skipped` after a prerequisite failure. `summary`
counts must exactly match the `checks` array.

`status: passed` means no check has status `failed`; warnings and explicit skips
are allowed, and the command exits `0`. `status: failed` means at least one
check failed and exits `30`. Invalid configuration prevents diagnostics and
returns `configuration_invalid` with exit `21`.

`passed` never upgrades delivery semantics. It does not prove that a future
notification will be accepted, delivered, displayed, or read.

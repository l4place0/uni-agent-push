# CLI process contract

Status: v1 proposal

This contract defines the stable process boundary used by Agents and scripts.
Human-readable wording is intentionally non-normative; JSON schemas, exit
classes, stream ownership, and side-effect ordering are normative.

## Output modes

Agent callers must pass `--json`. The human-only `config ui` command is the
single exception: it rejects `--json` and opens or pairs with a local browser as
defined by the [configuration UI contract](config-ui-contract.md).

In JSON mode, every normally handled invocation writes exactly one UTF-8 JSON
object followed by `\n` to stdout. It writes no banner, progress indicator,
ANSI escape, diagnostic prefix, or second JSON value. Contract-level failures
also use stdout and the versioned error receipt. Stderr remains empty.

Only failures before the CLI can initialize its JSON serializer, and external
hard termination such as `SIGKILL`, may end without a JSON object. Such failures
may write a human diagnostic to stderr and exit nonzero.

Without `--json`, stdout and stderr are for people and their wording is not an
API. Stdout carries the primary result; stderr carries warnings and diagnostics.
Human mode may use color only when the relevant output stream is an interactive
terminal and `NO_COLOR` is not set.

The CLI never writes secrets, provider target identifiers, message content, raw
provider responses, or authorization material to either stream. A caller that
needs to display message content already owns the request and should use that
request rather than recover content from CLI output.

## Exit codes

Exit codes are stable classes, not a substitute for parsing JSON:

| Code | Meaning |
| ---: | --- |
| `0` | Command succeeded; for a real send, top-level status is `accepted`. |
| `10` | Real send completed with top-level `rejected`. |
| `11` | Real send completed with top-level `uncertain`. |
| `12` | Broadcast completed with top-level `partial`. |
| `20` | CLI usage, input size, JSON, schema, or schema-version error. |
| `21` | Configuration is missing, unreadable, or invalid. |
| `22` | Destination or resolved routing does not exist. |
| `23` | Idempotency or ledger operation failed or conflicts. |
| `24` | Internal software failure not covered above. |
| `30` | `doctor` completed but one or more checks failed. |
| `130` | Caught `SIGINT` before provider dispatch began. |
| `143` | Caught `SIGTERM` before provider dispatch began. |

Successful `--dry-run`, `targets`, `channels`, `config validate`, and normal
`config ui` termination use `0`; their command-specific JSON result shapes will
be versioned independently. The four inspection command shapes are defined in
the [`inspection command contract`](inspection-commands.md). `doctor` uses `0`
when every check passes or is explicitly skipped, and `30` when at least one
check has status `failed`. Warnings alone do not produce `30`.

Error receipt mapping for `send` and `send --dry-run` is fixed:

| Error | Exit |
| --- | ---: |
| `invalid_cli_usage`, `invalid_input_size`, `invalid_json`, `invalid_schema`, `unsupported_schema_version` | `20` |
| `configuration_unavailable`, `configuration_invalid` | `21` |
| `destination_not_found` | `22` |
| `notification_conflict`, `notification_in_progress`, `ledger_corrupt`, `ledger_full`, `ledger_unavailable` | `23` |
| `internal_error` | `24` |
| `interrupted` | `130` or `143`, according to the caught signal |

## Input precedence

`uni-push send --request FILE --json` reads exactly one request object. `FILE`
may be `-` for stdin. Input must be UTF-8 and must fit the implementation's
documented bounded input size before JSON parsing.

`--request` cannot be combined with content, destination, notification, or
policy flags. Repeated singular flags, unknown flags, trailing positional
arguments, an empty stdin, or more than one JSON value are
`invalid_cli_usage` or `invalid_json` as applicable. Environment variables may
select configuration and secret references, but cannot override request fields.

Flag mode is normalized into the exact send-request schema before validation.
Both input modes therefore share canonicalization, fingerprinting, routing, and
receipt behavior.

## Real-send ordering

The CLI validates all input and configuration before any provider side effect.
It then claims the notification ID, executes the delivery policy, stores the
terminal receipt in the ledger, and only then writes that receipt to stdout.
The durable state machine and recovery boundary are defined by the
[`idempotency ledger contract`](idempotency-ledger.md).

If stdout closes after dispatch, the CLI must not retry. The stored receipt is
returned by an exact replay of the same notification request. If termination or
transport loss occurs after provider dispatch starts and acceptance cannot be
established, the attempt is recorded as `uncertain`; fallback does not continue.

A caught signal before dispatch produces `interrupted` and no idempotency
terminal receipt. After dispatch begins, the CLI makes a bounded best effort to
record an accepted, rejected, or uncertain receipt. Hard termination cannot be
made reliable and is explicitly outside the process contract.

## Dry-run contract

`uni-push send --dry-run --json` performs the same parsing, schema validation,
configuration loading, static cross-reference validation, policy resolution,
canonicalization, fingerprinting, static provider capability checks, and
content-transformation planning as a real send.

It must not:

- resolve an environment or keychain secret;
- acquire or mutate an idempotency-ledger claim;
- perform DNS, network, token, authentication, or provider operations;
- serialize or transmit a credential-bearing provider request;
- write configuration or any other persistent state.

Its normative success shape is
[`schemas/dry-run-result.v1.schema.json`](../schemas/dry-run-result.v1.schema.json).
The plan contains configured channel names and provider types, but no raw chat
ID, OpenID, recipient address, endpoint, secret reference, title, or body.

For `single`, only the first channel is planned with `condition: always`. For
`fallback`, the first channel is `always` and each later channel is
`after_prior_rejected`. For `broadcast`, every channel is `always`. Plan order
is the same order a real send would use.

`plan_completeness: complete` means every content transformation is knowable
from non-secret configuration. `secret_dependent` means the adapter has a
capability that cannot be resolved without reading a secret. In v1 this applies
to ServerChan edition detection from its SendKey. The plan lists only guaranteed
transformations and emits `secret_dependent_capabilities_not_checked`; a real
send or `doctor` may discover additional transformations or an incompatible
option. Dry-run never weakens its no-secret-access guarantee to hide this gap.

`status: ready` means the request and static plan are valid. It does not mean
credentials work, a provider is reachable, or a real send will be accepted.

## Versioning

Adding an exit code, changing the meaning of an existing code, allowing extra
stdout records, changing a JSON field's meaning, or weakening a dry-run
guarantee requires a versioned contract change. Human-readable text may evolve
without a schema version bump.

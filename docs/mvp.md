# Uni Push IM MVP

This is the implemented surface. Other documents in `docs/` are future
hardening proposals and are not promises of current runtime behavior.

## Requirements

- Node.js 22.13 or newer
- Credentials and one fixed target for ServerChan, Telegram Bot, or QQ Bot

No npm dependencies are required.

## Configure

For first-time setup, start the guided local page:

```bash
node bin/uni-push.js onboard
```

Without `--config` or `UNI_PUSH_CONFIG`, onboarding uses:

- `$XDG_CONFIG_HOME/uni-push/config.json` when `XDG_CONFIG_HOME` is set;
- otherwise `~/.config/uni-push/config.json` on macOS/Linux;
- `%APPDATA%\\uni-push\\config.json` on Windows.

The four-step page selects a provider and accepts its secret through a password
field. ServerChan needs a SendKey; Telegram needs a Bot Token and Chat ID; QQ
Bot needs an AppID, AppSecret, target type, and opaque OpenID. The OpenID is not
a numeric QQ number or group number.

Target acquisition is part of Onboarding rather than an assumed prerequisite:

- Telegram users can start the exact Bot or mention it in the target group,
  then use “查找候选 Chat ID”. The assistant checks for an active webhook,
  reads unacknowledged pending updates only when safe, verifies candidates with
  `getChat`, and returns only ID and chat type. It never returns names or message
  bodies. With an active webhook, use the existing webhook event's `chat.id`.
- QQ users must first trigger a group or C2C inbound event through the Bot's
  WebSocket Gateway or Webhook and extract the corresponding group/user OpenID.
  OpenIDs are scoped to the Bot AppID and cannot be derived from QQ numbers.
  The current MVP explains and assists this path but does not run a QQ event
  gateway or enumerate targets from AppID/AppSecret.

The page creates missing directories, saves a `store:<connection>` reference
in config, and writes the value to an adjacent `*.credentials.json` file. On
POSIX the credential file is mode `0600`; the value is not encrypted at rest.
The page and API never return the credential, and clear the password after save.

The page then checks the stored credential and offers an optional real test
notification. Test sending requires an explicit checkbox confirmation and is
deduplicated within that UI session.

For manual or automated configuration, copy `examples/mvp-config.json`, then
export the referenced secret:

```bash
export UNI_PUSH_CONFIG=/absolute/path/to/config.json
export SERVERCHAN_SEND_KEY='your-send-key'
node bin/uni-push.js config validate --json
```

Environment references remain supported for automation. Config contains only
`env:VARIABLE` or `store:<connection>`, never the credential value.

To edit through the local page:

```bash
node bin/uni-push.js config ui
```

The MVP page binds `127.0.0.1`, opens a tokenized local URL, validates with the
same runtime code, and atomically replaces the JSON file. It does not yet
support Keychain, pairing codes, or crash-safe multi-store rollback.
The general `config ui` editor does not send tests; the explicitly guided
`onboard` mode owns that confirmation flow.

## Send

Preview without accessing the secret, ledger, or network:

```bash
node bin/uni-push.js send \
  --request examples/mvp-request.json \
  --dry-run \
  --json
```

Perform a real send only after explicit authorization:

```bash
node bin/uni-push.js send \
  --request examples/mvp-request.json \
  --json
```

The first real send creates `<config>.ledger.json`. Replaying the same
notification ID and exact request returns the stored receipt. Reusing the ID
with changed content returns `notification_conflict`.

## Inspect and verify

```bash
node bin/uni-push.js targets --json
node bin/uni-push.js channels --json
node bin/uni-push.js doctor --json
npm test
```

`doctor` never sends a message. ServerChan is checked locally; Telegram calls
`getMe` and `getChat`; QQ Bot obtains an App Access Token but does not call a
message endpoint.

## MVP limitations

- ServerChan, Telegram Bot, and QQ Bot; single policy and one channel per target.
- QQ Bot requires a user/group OpenID captured from that Bot's inbound event;
  the MVP documents the assisted path but includes no QQ event gateway.
- Telegram Markdown is sent as visible plain text in this MVP; QQ Bot uses its
  native custom Markdown message form.
- Private local credential-file and environment references; no Keychain or
  encrypted-at-rest storage yet.
- Basic atomic-JSON replay, without stale-pending crash recovery or retention GC.
- GitHub Release publishing is owned by the independent production CLI repository.
- `uncertain` outcomes are never retried automatically.

# Uni Push operations

## Target acquisition

Telegram Chat ID:

1. Ask the user to start the exact Bot in private chat, or add it to the target
   group and send `/start@bot_username` or mention it.
2. Use Onboarding's “查找候选 Chat ID”. It refuses `getUpdates` when a webhook
   is active, verifies candidates with `getChat`, and returns only ID and type.
3. With an active webhook, inspect the existing event for `chat.id`; never
   disable the webhook or invent a `-100` prefix.
4. Run `doctor`, then ask for explicit confirmation before the test send.

QQ OpenID:

1. QQ numbers and group numbers are invalid. OpenIDs are opaque and scoped to
   the Bot AppID; they cannot be reused across Bots.
2. Enable group/C2C events and connect the Bot's existing WebSocket Gateway or
   Webhook. Ask the user to message the Bot or mention it in the target group.
3. Inspect the local inbound event and extract only the corresponding user or
   group OpenID. Avoid copying full events containing message or identity data.
4. The CLI cannot enumerate QQ targets from AppID/AppSecret. If no receiver
   exists, offer a bounded temporary receiver as a separate setup step.
5. `doctor` proves credential access only; a real relationship test requires
   the user's explicit confirmation.

## Send workflow

1. Run `uni-push targets --json` when the logical target is unknown.
2. Create a versioned request JSON with a unique notification ID, target,
   title, body, `plain` or `markdown`, priority, and `single` policy.
3. Use `send --dry-run --json` when destination or rendering needs review.
4. Use the real `send --json` only within explicit authorization.
5. Report `accepted`, `rejected`, `uncertain`, or `error` exactly as returned.

Use `UNI_PUSH_CONFIG` or `--config` for a non-default configuration path.

## Issue reports

The thin issue script records only:

- UTC timestamp, OS, and architecture;
- binary version;
- sanitized `doctor`, `targets`, and `channels` JSON output.

It does not copy configuration JSON, credential files, environment variables,
ledger contents, provider tokens, SendKeys, AppSecrets, Chat IDs, or OpenIDs.
Target and channel aliases may still be private; the user must review the local
Markdown report before sharing it.

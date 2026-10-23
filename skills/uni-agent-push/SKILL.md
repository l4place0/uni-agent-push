---
name: uni-agent-push
description: Install, update, onboard, diagnose, and use the Uni Push binary for explicit Agent notifications through ServerChan, Telegram Bot, or QQ Bot. Use when a user asks to install or update Uni Push; configure or discover a Telegram Chat ID or QQ OpenID; collect a sanitized issue report; inspect notification targets; or push, notify, alert, or send a completion/status message outside the current conversation.
---

# Uni Push

This Skill is a documentation and thin-script layer. All provider, credential,
routing, WebUI, idempotency, and delivery behavior belongs to the independent
`uni-push` binary built and released from this repository. The Skill itself is
versioned here at `skills/uni-agent-push`; the CLI source, tests, and release
workflows live beside it in the same repository.

## Safety

- Send externally only when the user explicitly requests a notification.
- Never request, print, or place provider credentials in chat or commands. Let
  the user enter them into the loopback Onboarding password field.
- Prefer configured logical targets. Keep the same notification ID only for an
  exact retry; never automatically retry an `uncertain` result.
- `accepted` means provider API acceptance, not human receipt or reading.
- Issue collection is local and sanitized. Never create or upload a GitHub Issue
  without a separate explicit request after the user reviews the report.

## Select the platform script

On macOS or Linux invoke scripts ending in `.sh` through `sh`; do not depend on
their executable mode because GitHub Skill installation may not preserve it.
On Windows use the matching `.ps1` script. The installers detect `x64` versus
`arm64`, download the matching GitHub Release asset, verify it against
`SHA256SUMS`, and install atomically.

Script paths below are relative to this skill directory (`skills/uni-agent-push`).

Default install locations:

- macOS/Linux: `${XDG_BIN_HOME:-$HOME/.local/bin}/uni-push`
- Windows: `%LOCALAPPDATA%\UniPush\bin\uni-push.exe`

Override them with `UNI_PUSH_INSTALL_DIR`, `UNI_PUSH_BIN`, `UNI_PUSH_VERSION`,
or `UNI_PUSH_REPOSITORY`.

## Workflows

- Install: run `sh scripts/install.sh` or `scripts/install.ps1`.
- Update: run `sh scripts/update.sh` or `scripts/update.ps1`.
- First setup: run `sh scripts/onboard.sh` or `scripts/onboard.ps1`; it installs
  the binary first when necessary, then starts the binary-owned local WebUI.
- Issue report: run `sh scripts/issue.sh` or `scripts/issue.ps1`. Review the
  emitted Markdown before any external submission.
- Normal sends: invoke the installed `uni-push` binary, not repository source.

For target-ID assistance and exact request behavior, read
[references/operations.md](references/operations.md).

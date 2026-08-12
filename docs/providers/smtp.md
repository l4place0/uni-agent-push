# SMTP provider contract

Status: v1 proposal

This adapter submits notification email to a user-configured SMTP relay. It
does not discover MX hosts, provide a hosted mail service, or infer recipients
from Agent input.

## Standards boundary

The transaction follows SMTP as defined by RFC 5321, authenticated submission
as defined by RFC 4954, STARTTLS as defined by RFC 3207, and the current
recommendation to use TLS for message submission in RFC 8314. Message bodies
use MIME and Internet Message Format rules.

An `accepted` SMTP attempt means only that the configured relay returned a
successful completion reply after the terminating `DATA` sequence. The receipt
therefore reports `acceptance_scope: smtp_relay_only`. It does not mean final
mailbox delivery, inbox placement, display, reading, or acknowledgement. A
later bounce is outside the synchronous v1 result.

## Configuration

An SMTP connection contains:

- `host` and `port` for the fixed, user-configured relay;
- `security`, exactly `tls` for implicit TLS or `starttls` for mandatory
  STARTTLS;
- `username` and a secret-reference-only `password`;
- a fixed ASCII envelope/header `from` address;
- an optional UTF-8 `from_name`, encoded by the MIME library when required.

An SMTP channel contains a non-empty `to` list and optional `cc`, `bcc`, and
`reply_to`. `bcc` recipients participate in the SMTP envelope but never appear
in message headers. Across all three recipient lists, v1 allows at most 50
unique addresses; duplicates across lists are a configuration error. Envelope
addresses are ASCII in v1, so SMTPUTF8 is not negotiated.

The Agent may select only a configured channel or logical target. It cannot
supply a relay host, sender, recipient, reply address, authentication option,
or arbitrary message header in a send request.

## TLS and authentication

Plaintext SMTP is unsupported. Certificate-chain and hostname verification are
mandatory and cannot be disabled in configuration.

For `starttls`, the client sends `EHLO`, requires the `STARTTLS` capability,
upgrades the connection, verifies TLS, discards all capabilities learned before
the upgrade, and sends `EHLO` again. Failure at any step is definitive
`transport_rejected`; the adapter never falls back to cleartext.

Authentication occurs only inside verified TLS and only through a mechanism
advertised after TLS. V1 supports `PLAIN` and `LOGIN`, preferring `PLAIN` when
both are available. Credentials are never logged or returned. A structured
authentication failure is `authentication_rejected`; a connection loss before
the mail transaction begins is `transport_rejected`.

## Message construction

The adapter uses a maintained MIME library rather than assembling headers or
SMTP framing by string concatenation. It rejects CR or LF in every configured
header value and address.

The message includes `Date`, deterministic `Message-ID`, `From`, `To`, optional
`Cc` and `Reply-To`, `Subject`, and `MIME-Version`. The `Message-ID` is derived
from the canonical request fingerprint and sender domain; this assists
diagnosis but is not a provider idempotency guarantee. The local ledger remains
authoritative.

Input is mapped as follows:

- `title` becomes the encoded `Subject` without truncation;
- plain input becomes UTF-8 `text/plain`;
- Markdown becomes `multipart/alternative` with a safe UTF-8 plain-text part
  and a sanitized HTML part rendered from a strict CommonMark subset;
- raw HTML is escaped, and Markdown images become ordinary links;
- `url`, when present, is appended as an explicit link;
- `summary` and `tags` are omitted and reported as transformations;
- `priority` remains a router signal; v1 does not synthesize `X-Priority`.

The MIME library owns RFC-compliant header encoding, transfer encoding, CRLF
normalization, line folding, multipart boundaries, and SMTP dot transparency.
The adapter reports `markdown_to_email_multipart`, `markdown_image_to_link`,
`url_appended_to_body`, `summary_omitted`, and `tags_omitted` when applicable.
It never silently truncates content.

## Transaction and recipient atomicity

V1 treats one configured SMTP channel as one atomic attempt:

1. Establish and verify TLS, authenticate, and issue `MAIL FROM`.
2. Issue `RCPT TO` for every `to`, `cc`, and `bcc` recipient.
3. If any recipient is rejected, issue `RSET`, do not issue `DATA`, and return
   `rejected` with `invalid_target` for a recipient-address rejection or the
   appropriate stable reason for another structured refusal.
4. Only after every recipient is accepted, issue `DATA` and submit the MIME
   message.
5. Mark the attempt `accepted` only after the relay's successful final reply.

This deliberately favors an all-or-none local submission contract. It cannot
guarantee that the relay will treat recipients atomically after acceptance.

## Result mapping and retries

| Observation | Attempt result |
| --- | --- |
| DNS, TCP, TLS, capability, or pre-transaction connection failure | `rejected / transport_rejected` |
| Credentials refused | `rejected / authentication_rejected` |
| Any recipient refused before `DATA` | `rejected / invalid_target` or `provider_rejected` |
| Structured final 4xx/5xx after `DATA` | `rejected / provider_rejected` |
| Successful final reply after `DATA` | `accepted / provider_accepted` |
| Timeout or disconnect after `DATA` begins, including while awaiting its final reply | `uncertain / timeout_after_send` or `transport_ambiguous` |

The adapter performs no automatic send retry. In particular, retrying an
ambiguous post-`DATA` failure could duplicate mail. Fallback routing stops on
`uncertain` under the shared v1 policy.

Connection establishment has a 5-second limit. The complete authenticated SMTP
transaction has a 30-second limit. Either may be made stricter only by a future
versioned configuration field; v1 has no Agent-controlled timeout.

## Diagnostics and configuration UI

`doctor` may resolve the password reference, establish TLS, send `EHLO`, and
perform one authentication attempt. It must not send `MAIL FROM`, `RCPT TO`, or
`DATA`; therefore it cannot verify sender or recipient authorization. Results
and the HTML configuration assistant expose only redacted host, security,
sender, recipient counts, and diagnostic status. Existing passwords are never
returned to the browser.

## Explicit v1 exclusions

- plaintext SMTP and opportunistic TLS downgrade;
- direct-to-MX delivery;
- attachments and inline media;
- SMTPUTF8 envelope addresses;
- OAuth2/SASL mechanisms beyond `PLAIN` and `LOGIN`;
- DSN tracking, bounce ingestion, and inbox-placement claims;
- client-side DKIM signing, S/MIME, and OpenPGP;
- custom headers, mailing-list expansion, templates, and arbitrary HTML.

DKIM signing and downstream delivery policy are responsibilities of the
configured relay.

## Primary references

- [RFC 5321 — Simple Mail Transfer Protocol](https://www.rfc-editor.org/rfc/rfc5321)
- [RFC 3207 — SMTP STARTTLS](https://www.rfc-editor.org/rfc/rfc3207)
- [RFC 8314 — TLS for email submission](https://www.rfc-editor.org/rfc/rfc8314)
- [RFC 4954 — SMTP Authentication](https://www.rfc-editor.org/rfc/rfc4954)
- [RFC 5322 — Internet Message Format](https://www.rfc-editor.org/rfc/rfc5322)
- [RFC 2045 and RFC 2046 — MIME](https://www.rfc-editor.org/rfc/rfc2045)
- [RFC 2047 — encoded message headers](https://www.rfc-editor.org/rfc/rfc2047)

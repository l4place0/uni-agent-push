# Idempotency ledger

The production CLI uses a versioned JSON ledger adjacent to the configuration:

```text
<config>.ledger.json
```

This avoids native modules inside the standalone binary while preserving the
prototype's delivery semantics.

## Contract

- A new `notification_id` and request fingerprint atomically creates a
  `pending` record before provider dispatch.
- The same ID with a different fingerprint returns `notification_conflict`.
- The same ID and fingerprint while pending returns
  `notification_in_progress`.
- Completion atomically replaces the record with `terminal` plus the sanitized
  delivery receipt.
- An exact replay returns that receipt without another provider call.

The ledger is written with mode `0600` through a same-directory temporary file
and atomic rename. A `wx` lock file serializes writers across processes, with a
bounded one-second acquisition wait. The ledger contains request fingerprints,
state, timestamps, and sanitized receipts; it never contains provider secrets.

## Known limitation

A process crash after claim and before completion leaves a pending record that
requires manual investigation. Automatic stale-claim recovery and retention GC
remain future hardening work because blind replay could duplicate an external
notification.

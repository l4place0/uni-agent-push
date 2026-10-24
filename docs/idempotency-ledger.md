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

## Offline lock recovery

A crashed process can leave `<ledger>.lock`. Writers never steal locks on a
timeout: doing so can allow concurrent claims and duplicate external sends.
Stop **all** CLI send processes and configuration UI instances that use this
ledger, and prevent scheduled writers from starting during maintenance. Then run:

```sh
uni-push ledger recover-lock --config /path/to/config.json --writers-stopped --json
# Or specify --ledger /path/to/custom.ledger.json for a custom ledger.
```

`--writers-stopped` explicitly asserts that maintenance precondition; it is not
an automatic process shutdown. The command removes only the lock, never pending
records or terminal receipts. It supports legacy empty locks and locks whose
owner metadata was not written before a crash. New locks contain an owner PID;
recovery refuses a PID that is alive or cannot be checked. PID reuse may require
waiting for that unrelated process to exit. PID checks alone do not prevent
recovery races, so concurrent writers or recovery commands are unsupported during
maintenance. Resume writers after recovery completes. Existing pending records
still require investigation; use a fresh ID only for a genuinely new notification.

Terminal replay reads the ledger before resolving credentials. A missing or
revoked current credential therefore does not prevent returning an exact receipt.
New sends validate credentials before claiming, then atomically check again for
a concurrent claim or completion.

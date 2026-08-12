import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UniPushError } from "./errors.js";

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function emptyLedger() {
  return { schema_version: 1, notifications: {} };
}

export class Ledger {
  constructor(path) {
    this.path = path;
    this.memory = path === ":memory:" ? emptyLedger() : undefined;
    try {
      if (!this.memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch {
      throw new UniPushError("ledger_unavailable", "Unable to open idempotency ledger", 23);
    }
  }

  withLock(action) {
    if (this.memory) return action(this.memory, () => {});
    const lockPath = `${this.path}.lock`;
    let descriptor;
    const deadline = Date.now() + 1000;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST" || Date.now() >= deadline) {
          throw new UniPushError("ledger_unavailable", "Unable to lock idempotency ledger", 23);
        }
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }
    try {
      let ledger;
      try {
        ledger = JSON.parse(readFileSync(this.path, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        ledger = emptyLedger();
      }
      if (ledger?.schema_version !== 1 || typeof ledger.notifications !== "object" || ledger.notifications === null || Array.isArray(ledger.notifications)) throw new Error("invalid ledger");
      return action(ledger, () => this.write(ledger));
    } catch (error) {
      if (error instanceof UniPushError) throw error;
      throw new UniPushError("ledger_unavailable", "Unable to access idempotency ledger", 23);
    } finally {
      try { closeSync(descriptor); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }

  write(ledger) {
    const temporary = join(dirname(this.path), `.uni-push-ledger-${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } catch (error) {
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  claim(notificationId, fingerprint) {
    return this.withLock((ledger, persist) => {
      const existing = ledger.notifications[notificationId];
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) return { kind: "conflict" };
        if (existing.state === "terminal") return { kind: "replay", receipt: existing.receipt };
        return { kind: "in_progress" };
      }
      ledger.notifications[notificationId] = {
        request_fingerprint: fingerprint,
        state: "pending",
        created_at: new Date().toISOString(),
      };
      persist();
      return { kind: "claimed" };
    });
  }

  complete(notificationId, fingerprint, receipt) {
    this.withLock((ledger, persist) => {
      const record = ledger.notifications[notificationId];
      if (!record || record.request_fingerprint !== fingerprint || record.state !== "pending") {
        throw new UniPushError("ledger_unavailable", "Unable to store delivery receipt", 23);
      }
      record.state = "terminal";
      record.receipt = receipt;
      persist();
    });
  }

  close() {}
}

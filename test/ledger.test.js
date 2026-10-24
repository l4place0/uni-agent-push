import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger, recoverLedgerLock } from "../src/ledger.js";
function fixture(t) {
 const dir = mkdtempSync(join(tmpdir(), "ledger-regression-"));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 return join(dir, "ledger.json");
}
test("inherited property IDs persist, replay, and conflict normally", t => {
 const path = fixture(t);
 for (const id of ["constructor", "toString", "__proto__"]) {
  const ledger = new Ledger(path);
  assert.equal(ledger.claim(id, "fingerprint").kind, "claimed");
  assert.equal(new Ledger(path).claim(id, "fingerprint").kind, "in_progress");
  ledger.complete(id, "fingerprint", { status: "accepted" });
  assert.equal(new Ledger(path).inspect(id, "fingerprint").kind, "replay");
  assert.equal(ledger.claim(id, "other").kind, "conflict");
 }
});
test("offline recovery removes legacy lock while preserving pending and terminal records", t => {
 const path = fixture(t);
 const ledger = new Ledger(path);
 ledger.claim("pending", "a"); ledger.claim("complete", "b");
 ledger.complete("complete", "b", { status: "uncertain" });
 const before = readFileSync(path, "utf8");
 writeFileSync(`${path}.lock`, "");
 assert.throws(() => recoverLedgerLock(path), { code: "invalid_cli_usage" });
 assert.equal(existsSync(`${path}.lock`), true);
 assert.deepEqual(recoverLedgerLock(path, { writersStopped: true }), { recovered: true });
 assert.equal(readFileSync(path, "utf8"), before);
 assert.equal(ledger.claim("new", "c").kind, "claimed");
 assert.equal(ledger.claim("pending", "a").kind, "in_progress");
 assert.equal(ledger.inspect("complete", "b").receipt.status, "uncertain");
});
test("active owner lock cannot be recovered or stolen", t => {
 const path = fixture(t);
 writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid }));
 assert.throws(() => recoverLedgerLock(path, { writersStopped: true }), { code: "ledger_unavailable" });
 assert.throws(() => new Ledger(path).claim("fresh", "a"), { code: "ledger_unavailable" });
 assert.equal(existsSync(`${path}.lock`), true);
});

 test("independent processes serialize competing claims", async t => {
 const { execFile } = await import("node:child_process");
 const { promisify } = await import("node:util");
 const run = promisify(execFile);
 const path = fixture(t);
 const moduleUrl = new URL("../src/ledger.js", import.meta.url).href;
 const source = `import { Ledger } from ${JSON.stringify(moduleUrl)}; console.log(new Ledger(process.argv[1]).claim("shared", "fp").kind);`;
 const results = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath, ["--input-type=module", "-e", source, path])));
 const kinds = results.map(result => result.stdout.trim());
 assert.equal(kinds.filter(kind => kind === "claimed").length, 1);
 assert.equal(kinds.filter(kind => kind === "in_progress").length, 5);
});

test("offline recovery permits a confirmed exited lock owner", async t => {
 const { execFileSync } = await import("node:child_process");
 const path = fixture(t);
 const pid = Number(execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim());
 writeFileSync(`${path}.lock`, JSON.stringify({ pid }));
 assert.equal(recoverLedgerLock(path, { writersStopped: true }).recovered, true);
 assert.equal(new Ledger(path).claim("fresh", "fp").kind, "claimed");
});

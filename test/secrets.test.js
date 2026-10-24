import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialsPath, resolveSecret, saveStoredSecret } from "../src/secrets.js";

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-secrets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "config.json");
}

test("concurrent credential saves preserve every successful write", async (t) => {
  const configPath = await workspace(t);
  await saveStoredSecret(configPath, "existing", "original");
  await Promise.all(Array.from({ length: 12 }, (_, i) => saveStoredSecret(configPath, `key${i}`, `value${i}`)));
  assert.equal(await resolveSecret("store:existing", { configPath }), "original");
  for (let i = 0; i < 12; i++) {
    assert.equal(await resolveSecret(`store:key${i}`, { configPath }), `value${i}`);
  }
});

test("credential writes from independent processes preserve all keys", async (t) => {
  const configPath = await workspace(t);
  const script = fileURLToPath(new URL("../test-support/save-credential.mjs", import.meta.url));
  await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, configPath, `child${i}`], { windowsHide: true });
    let output = "";
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${output}`)));
  })));
  for (let i = 0; i < 4; i++) {
    assert.equal(await resolveSecret(`store:child${i}`, { configPath }), "dummy-value");
  }
});

test("invalid credential stores remain intact and release their lock", async (t) => {
  const configPath = await workspace(t);
  const path = credentialsPath(configPath);
  await writeFile(path, "invalid-json");
  await assert.rejects(saveStoredSecret(configPath, "first", "value"), { code: "credential_unavailable" });
  assert.equal(await readFile(path, "utf8"), "invalid-json");
  await writeFile(path, JSON.stringify({ version: 1, secrets: {} }));
  await saveStoredSecret(configPath, "retry", "works");
  assert.equal(await resolveSecret("store:retry", { configPath }), "works");
});

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { UniPushError } from "./errors.js";

const ENV_REF = /^env:([A-Z_][A-Z0-9_]*)$/;
const STORE_REF = /^store:([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*)$/;

export function validSecretReference(reference) {
  return typeof reference === "string" && (ENV_REF.test(reference) || STORE_REF.test(reference));
}

export function storedSecretId(reference) {
  return STORE_REF.exec(reference)?.[1];
}

export function credentialsPath(configPath) {
  const extension = extname(configPath);
  const stem = basename(configPath, extension);
  return join(dirname(configPath), `${stem}.credentials.json`);
}

function emptyStore() {
  return { version: 1, secrets: {} };
}

async function readStore(configPath, { allowMissing = false } = {}) {
  let text;
  try {
    text = await readFile(credentialsPath(configPath), "utf8");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return emptyStore();
    throw new UniPushError("credential_unavailable", "Credential store is unavailable", 21);
  }
  try {
    const store = JSON.parse(text);
    if (store?.version !== 1 || !store.secrets || typeof store.secrets !== "object" || Array.isArray(store.secrets)) throw new Error();
    return store;
  } catch {
    throw new UniPushError("credential_unavailable", "Credential store is invalid", 21);
  }
}

async function writeStore(configPath, store) {
  const path = credentialsPath(configPath);
  const directory = dirname(path);
  const temporary = join(directory, `.uni-push-credentials-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new UniPushError("credential_write_failed", "Unable to save credential", 21);
  }
}

async function withStoreLock(configPath, action) {
  const lockPath = `${credentialsPath(configPath)}.lock`;
  let handle;
  const deadline = Date.now() + 5000;
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
        await setTimeout(10);
      }
    }
  } catch {
    throw new UniPushError("credential_write_failed", "Unable to lock credential store", 21);
  }
  try {
    // Lock the entire read/modify/write transaction across UI requests and CLI
    // processes. Never remove another writer's lock on timeout.
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath);
  }
}

export async function saveStoredSecret(configPath, id, value) {
  if (!STORE_REF.test(`store:${id}`) || typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new UniPushError("credential_invalid", "Credential is invalid", 21);
  }
  configPath = resolve(configPath);
  await withStoreLock(configPath, async () => {
    const store = await readStore(configPath, { allowMissing: true });
    store.secrets[id] = value;
    await writeStore(configPath, store);
  });
}

export async function hasStoredSecret(configPath, id) {
  try {
    const store = await readStore(configPath);
    return typeof store.secrets[id] === "string" && store.secrets[id].length > 0;
  } catch (error) {
    if (error?.code === "credential_unavailable") return false;
    throw error;
  }
}

export async function resolveSecret(reference, { env = process.env, configPath } = {}) {
  const environment = ENV_REF.exec(reference);
  if (environment) {
    const value = env[environment[1]];
    if (!value) throw new UniPushError("credential_unavailable", "Referenced environment credential is unavailable", 21);
    return value;
  }
  const id = storedSecretId(reference);
  if (id) {
    if (!configPath) throw new UniPushError("credential_unavailable", "Credential store path is unavailable", 21);
    const store = await readStore(configPath);
    const value = store.secrets[id];
    if (typeof value !== "string" || value.length === 0) throw new UniPushError("credential_unavailable", "Stored credential is unavailable", 21);
    return value;
  }
  throw new UniPushError("configuration_invalid", "Unsupported credential reference", 21);
}

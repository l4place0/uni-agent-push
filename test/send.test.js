import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendNotification } from "../src/send.js";
import { saveStoredSecret } from "../src/secrets.js";
import { clearQQTokenCache } from "../src/providers/qqbot.js";
import { config, request } from "../test-support/fixtures.js";

async function temporaryLedger(testContext) {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-test-"));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "ledger.json");
}

test("dry-run has no secret, ledger, or network side effect", async () => {
  let calls = 0;
  const result = await sendNotification({
    config: config(),
    request: request(),
    ledgerPath: "/must/not/be/opened.json",
    dryRun: true,
    env: new Proxy({}, { get() { throw new Error("secret accessed"); } }),
    fetchImpl: async () => { calls += 1; throw new Error("network accessed"); },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.guarantees.network_access, false);
  assert.equal(calls, 0);
});

test("accepted send is stored and exact replay calls provider once", async (t) => {
  const ledgerPath = await temporaryLedger(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  const options = { config: config(), request: request(), ledgerPath, env: { SERVERCHAN_SEND_KEY: "SCTabc" }, fetchImpl };
  const first = await sendNotification(options);
  const second = await sendNotification({ ...options, env: new Proxy({}, { get() { throw new Error("secret accessed on replay"); } }) });
  assert.equal(first.status, "accepted");
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("SCTabc"), false);
  assert.equal(serialized.includes("The deterministic test finished"), false);
  assert.equal(serialized.includes("sctapi.ftqq.com"), false);
});

test("stored credential resolves for send and missing store fails before network", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-stored-send-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const storedConfig = config();
  storedConfig.connections["serverchan-main"].send_key = "store:serverchan-main";
  await saveStoredSecret(configPath, "serverchan-main", "SCTstored-send");
  let calls = 0;
  const result = await sendNotification({
    config: storedConfig,
    configPath,
    request: request({ notification_id: "stored-send-1" }),
    ledgerPath: join(directory, "ledger.json"),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    },
  });
  assert.equal(result.status, "accepted");
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes("SCTstored-send"), false);

  await assert.rejects(() => sendNotification({
    config: storedConfig,
    configPath: join(directory, "missing.json"),
    request: request({ notification_id: "stored-send-2" }),
    ledgerPath: join(directory, "missing-ledger.json"),
    fetchImpl: async () => { calls += 1; },
  }), { code: "credential_unavailable" });
  assert.equal(calls, 1);
});

test("changed request with reused ID conflicts without a second call", async (t) => {
  const ledgerPath = await temporaryLedger(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  const base = { config: config(), ledgerPath, env: { SERVERCHAN_SEND_KEY: "SCTabc" }, fetchImpl };
  await sendNotification({ ...base, request: request() });
  await assert.rejects(() => sendNotification({ ...base, request: request({ message: { body: "Changed" } }) }), { code: "notification_conflict" });
  assert.equal(calls, 1);
});

test("oversized body fails before secret and provider access", async (t) => {
  const ledgerPath = await temporaryLedger(t);
  let calls = 0;
  await assert.rejects(
    () => sendNotification({
      config: config(),
      request: request({ message: { body: "x".repeat(16385) } }),
      ledgerPath,
      env: new Proxy({}, { get() { throw new Error("secret accessed"); } }),
      fetchImpl: async () => { calls += 1; },
    }),
    { code: "invalid_schema" },
  );
  assert.equal(calls, 0);
});

test("unified send dispatches Telegram and QQ Bot with sanitized receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-multi-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const telegramPath = join(directory, "telegram.json");
  const telegram = {
    version: 1,
    connections: { "telegram-main": { provider: "telegram", token: "store:telegram-main" } },
    channels: { "telegram.owner": { provider: "telegram", connection: "telegram-main", chat_id: "-1001234567890" } },
    targets: { owner: { channels: ["telegram.owner"], policy: "single" } },
  };
  const telegramToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
  await saveStoredSecret(telegramPath, "telegram-main", telegramToken);
  const telegramReceipt = await sendNotification({
    config: telegram, configPath: telegramPath,
    request: request({ notification_id: "telegram-unified-1" }),
    ledgerPath: join(directory, "telegram.json"),
    fetchImpl: async (url) => {
      assert.match(url, /api\.telegram\.org/);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
  });
  assert.equal(telegramReceipt.status, "accepted");
  assert.equal(telegramReceipt.attempts[0].provider, "telegram");
  assert.equal(JSON.stringify(telegramReceipt).includes(telegramToken), false);

  clearQQTokenCache();
  const qqPath = join(directory, "qq.json");
  const qq = {
    version: 1,
    connections: { "qq-main": { provider: "qqbot", app_id: "unique-app-unified", client_secret: "store:qq-main" } },
    channels: { "qq.owner": { provider: "qqbot", connection: "qq-main", target: { type: "user", openid: "opaque-user" } } },
    targets: { owner: { channels: ["qq.owner"], policy: "single" } },
  };
  const qqSecret = "qq-client-secret";
  await saveStoredSecret(qqPath, "qq-main", qqSecret);
  let qqCalls = 0;
  const qqReceipt = await sendNotification({
    config: qq, configPath: qqPath,
    request: request({ notification_id: "qq-unified-1" }),
    ledgerPath: join(directory, "qq.json"),
    fetchImpl: async () => {
      qqCalls += 1;
      return qqCalls === 1
        ? new Response(JSON.stringify({ access_token: "qq-access", expires_in: 7200 }), { status: 200 })
        : new Response(JSON.stringify({ id: "qq-message-id" }), { status: 200 });
    },
  });
  assert.equal(qqReceipt.status, "accepted");
  assert.equal(qqReceipt.attempts[0].provider, "qqbot");
  assert.equal(qqCalls, 2);
  assert.equal(JSON.stringify(qqReceipt).includes(qqSecret), false);
});

 test("preflight failure does not claim an ID", async (t) => {
  const ledgerPath = await temporaryLedger(t);
  const options = { config: config(), request: request(), ledgerPath, fetchImpl: async () => new Response(JSON.stringify({ code: 0 })) };
  await assert.rejects(() => sendNotification({ ...options, env: {} }), { code: "credential_unavailable" });
  assert.equal((await sendNotification({ ...options, env: { SERVERCHAN_SEND_KEY: "SCTabc" } })).status, "accepted");
});

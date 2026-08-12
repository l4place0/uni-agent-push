import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.js";
import { startConfigUi } from "../src/ui/server.js";
import { credentialsPath, resolveSecret } from "../src/secrets.js";
import { clearQQTokenCache } from "../src/providers/qqbot.js";

test("loopback UI serves assets, protects API, validates, and saves", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-ui-"));
  const configPath = join(directory, "config.json");
  const ui = await startConfigUi({ configPath, openBrowser: false });
  t.after(async () => {
    if (ui.server.listening) await ui.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.match(ui.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const page = await fetch(`${ui.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await page.text(), /Uni Push 配置/);

  const unauthorized = await fetch(`${ui.origin}/api/config`);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: `Bearer ${ui.token}` };
  const loaded = await fetch(`${ui.origin}/api/config`, { headers });
  assert.deepEqual(await loaded.json(), {
    config: defaultConfig(),
    credentials: { "serverchan-main": { source: "store", configured: false } },
  });

  const mutationHeaders = { ...headers, origin: ui.origin, "content-type": "application/json" };
  const validation = await fetch(`${ui.origin}/api/validate`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify(defaultConfig()),
  });
  assert.deepEqual(await validation.json(), { valid: true, issues: [] });

  const invalidCredential = await fetch(`${ui.origin}/api/save`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ config: defaultConfig(), credential: { id: "serverchan-main", value: "not-a-send-key" } }),
  });
  assert.equal(invalidCredential.status, 400);
  assert.deepEqual(await invalidCredential.json(), { error: "configuration_invalid" });
  await assert.rejects(readFile(credentialsPath(configPath), "utf8"), { code: "ENOENT" });

  const firstKey = "SCTstored-first";
  const saved = await fetch(`${ui.origin}/api/save`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ config: defaultConfig(), credential: { id: "serverchan-main", value: firstKey } }),
  });
  assert.deepEqual(await saved.json(), { saved: true });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), defaultConfig());
  if (process.platform !== "win32") {
    assert.equal((await stat(credentialsPath(configPath))).mode & 0o777, 0o600);
  }
  assert.equal((await resolveSecret("store:serverchan-main", { configPath })), firstKey);
  assert.equal((await readFile(configPath, "utf8")).includes(firstKey), false);

  const preserved = await fetch(`${ui.origin}/api/save`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ config: defaultConfig() }),
  });
  assert.deepEqual(await preserved.json(), { saved: true });
  assert.equal((await resolveSecret("store:serverchan-main", { configPath })), firstKey);

  const secondKey = "SCTstored-second";
  const replaced = await fetch(`${ui.origin}/api/save`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ config: defaultConfig(), credential: { id: "serverchan-main", value: secondKey } }),
  });
  assert.deepEqual(await replaced.json(), { saved: true });
  assert.equal((await resolveSecret("store:serverchan-main", { configPath })), secondKey);
  const reloaded = await fetch(`${ui.origin}/api/config`, { headers });
  const reloadedText = await reloaded.text();
  assert.equal(reloadedText.includes(firstKey), false);
  assert.equal(reloadedText.includes(secondKey), false);
  assert.deepEqual(JSON.parse(reloadedText).credentials, { "serverchan-main": { source: "store", configured: true } });
});

test("onboarding checks inherited secret and requires explicit deduplicated test confirmation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-onboard-"));
  const configPath = join(directory, "nested", "config.json");
  let providerCalls = 0;
  const ui = await startConfigUi({
    configPath,
    mode: "onboard",
    openBrowser: false,
    env: {},
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    },
  });
  t.after(async () => {
    if (ui.server.listening) await ui.close();
    await rm(directory, { recursive: true, force: true });
  });

  const headers = { authorization: `Bearer ${ui.token}` };
  const mutationHeaders = { ...headers, origin: ui.origin, "content-type": "application/json" };
  const session = await fetch(`${ui.origin}/api/session`, { headers });
  assert.deepEqual(await session.json(), { mode: "onboard", config_path: configPath });

  const testKey = "SCTtestsecret";
  const saved = await fetch(`${ui.origin}/api/save`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ config: defaultConfig(), credential: { id: "serverchan-main", value: testKey } }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), defaultConfig());

  const checked = await fetch(`${ui.origin}/api/check`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify(defaultConfig()),
  });
  const checkResult = await checked.json();
  assert.equal(checkResult.status, "passed");
  assert.equal(JSON.stringify(checkResult).includes(testKey), false);
  assert.equal(providerCalls, 0);

  const missingSecretConfig = structuredClone(defaultConfig());
  missingSecretConfig.connections["serverchan-main"].send_key = "env:MISSING_SEND_KEY";
  const missingCheck = await fetch(`${ui.origin}/api/check`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify(missingSecretConfig),
  });
  const missingResult = await missingCheck.json();
  assert.equal(missingResult.status, "failed");
  assert.equal(JSON.stringify(missingResult).includes(testKey), false);
  assert.equal(providerCalls, 0);

  const unconfirmed = await fetch(`${ui.origin}/api/test`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ config: defaultConfig(), confirmed: false }),
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(providerCalls, 0);

  const confirmedBody = JSON.stringify({ config: defaultConfig(), confirmed: true });
  const first = await fetch(`${ui.origin}/api/test`, { method: "POST", headers: mutationHeaders, body: confirmedBody });
  const firstResult = await first.json();
  assert.deepEqual(firstResult, { status: "accepted", reason: "provider_accepted", replayed: false });
  assert.equal(JSON.stringify(firstResult).includes(testKey), false);

  const replay = await fetch(`${ui.origin}/api/test`, { method: "POST", headers: mutationHeaders, body: confirmedBody });
  assert.deepEqual(await replay.json(), { status: "accepted", reason: "provider_accepted", replayed: true });
  assert.equal(providerCalls, 1);
});

test("onboarding saves, checks, and tests Telegram", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-ui-telegram-"));
  const configPath = join(directory, "config.json");
  const telegram = {
    version: 1,
    connections: { "telegram-main": { provider: "telegram", token: "store:telegram-main" } },
    channels: { "telegram.owner": { provider: "telegram", connection: "telegram-main", chat_id: "-1001234567890" } },
    targets: { owner: { channels: ["telegram.owner"], policy: "single" } },
  };
  const methods = [];
  const ui = await startConfigUi({ configPath, mode: "onboard", fetchImpl: async (url) => {
    const method = url.split("/").at(-1);
    methods.push(method);
    if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "" } }), { status: 200 });
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { text: "private", chat: { id: -1001234567890, type: "supergroup", title: "private" } } }] }), { status: 200 });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { is_bot: true } }), { status: 200 });
    if (method === "getChat") return new Response(JSON.stringify({ ok: true, result: { id: -1 } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  } });
  t.after(async () => { if (ui.server.listening) await ui.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${ui.token}`, origin: ui.origin, "content-type": "application/json" };
  const discovered = await fetch(`${ui.origin}/api/discover/telegram`, { method: "POST", headers, body: JSON.stringify({ config: telegram, credential: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd" }) });
  assert.deepEqual(await discovered.json(), { status: "passed", reason: "candidates_found", candidates: [{ chat_id: "-1001234567890", type: "supergroup" }] });
  const saved = await fetch(`${ui.origin}/api/save`, { method: "POST", headers, body: JSON.stringify({ config: telegram, credential: { id: "telegram-main", value: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd" } }) });
  assert.deepEqual(await saved.json(), { saved: true });
  const checked = await fetch(`${ui.origin}/api/check`, { method: "POST", headers, body: JSON.stringify(telegram) });
  assert.equal((await checked.json()).status, "passed");
  const sent = await fetch(`${ui.origin}/api/test`, { method: "POST", headers, body: JSON.stringify({ config: telegram, confirmed: true }) });
  assert.equal((await sent.json()).status, "accepted");
  assert.deepEqual(methods, ["getWebhookInfo", "getUpdates", "getChat", "getMe", "getChat", "sendMessage"]);
});

test("onboarding saves, checks, and tests QQ Bot", async (t) => {
  clearQQTokenCache();
  const directory = await mkdtemp(join(tmpdir(), "uni-push-ui-qq-"));
  const configPath = join(directory, "config.json");
  const qq = {
    version: 1,
    connections: { "qq-main": { provider: "qqbot", app_id: "ui-qq-app", client_secret: "store:qq-main" } },
    channels: { "qq.owner": { provider: "qqbot", connection: "qq-main", target: { type: "group", openid: "opaque-group" } } },
    targets: { owner: { channels: ["qq.owner"], policy: "single" } },
  };
  let tokenCalls = 0;
  let messageCalls = 0;
  const ui = await startConfigUi({ configPath, mode: "onboard", fetchImpl: async (url) => {
    if (url.endsWith("getAppAccessToken")) { tokenCalls += 1; return new Response(JSON.stringify({ access_token: "qq-token", expires_in: 7200 }), { status: 200 }); }
    messageCalls += 1;
    return new Response(JSON.stringify({ id: "qq-message" }), { status: 200 });
  } });
  t.after(async () => { if (ui.server.listening) await ui.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${ui.token}`, origin: ui.origin, "content-type": "application/json" };
  const saved = await fetch(`${ui.origin}/api/save`, { method: "POST", headers, body: JSON.stringify({ config: qq, credential: { id: "qq-main", value: "qq-client-secret" } }) });
  assert.deepEqual(await saved.json(), { saved: true });
  const checked = await fetch(`${ui.origin}/api/check`, { method: "POST", headers, body: JSON.stringify(qq) });
  assert.equal((await checked.json()).status, "passed");
  const sent = await fetch(`${ui.origin}/api/test`, { method: "POST", headers, body: JSON.stringify({ config: qq, confirmed: true }) });
  assert.equal((await sent.json()).status, "accepted");
  assert.equal(tokenCalls, 1);
  assert.equal(messageCalls, 1);
});

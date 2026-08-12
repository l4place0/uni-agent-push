import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseTelegram, discoverTelegramChats, prepareTelegram, sendPreparedTelegram } from "../src/providers/telegram.js";

const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
const channel = { provider: "telegram", chat_id: "-1001234567890", disable_link_preview: true };
const message = { title: "Done", body: "Build finished", format: "plain", priority: "normal" };

test("Telegram prepares fixed sendMessage request and accepts official success", async () => {
  const prepared = prepareTelegram({ token, channel, message });
  assert.equal(prepared.endpoint, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.deepEqual(prepared.body, { chat_id: channel.chat_id, text: "Done\n\nBuild finished", link_preview_options: { is_disabled: true } });
  let calls = 0;
  const result = await sendPreparedTelegram(prepared, { fetchImpl: async (_url, init) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  } });
  assert.deepEqual(result, { status: "accepted", reason: "provider_accepted", transformations: ["title_prefixed_to_body"] });
  assert.equal(calls, 1);
});

test("Telegram maps rate limit and ambiguous transport without leaking token", async () => {
  const prepared = prepareTelegram({ token, channel, message });
  const limited = await sendPreparedTelegram(prepared, { fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 429, description: token }), { status: 429 }) });
  assert.equal(limited.status, "rejected");
  assert.equal(limited.reason, "rate_limited");
  assert.equal(JSON.stringify(limited).includes(token), false);
  const timeout = new Error("timeout"); timeout.name = "TimeoutError";
  const uncertain = await sendPreparedTelegram(prepared, { fetchImpl: async () => { throw timeout; } });
  assert.deepEqual(uncertain, { status: "uncertain", reason: "timeout_after_send", transformations: ["title_prefixed_to_body"] });
});

test("Telegram distinguishes invalid targets from unsupported content", async () => {
  const prepared = prepareTelegram({ token, channel, message });
  const missingChat = await sendPreparedTelegram(prepared, { fetchImpl: async () => new Response(JSON.stringify({
    ok: false,
    error_code: 400,
    description: "Bad Request: chat not found",
  }), { status: 400 }) });
  assert.equal(missingChat.reason, "invalid_target");

  const badEntities = await sendPreparedTelegram(prepared, { fetchImpl: async () => new Response(JSON.stringify({
    ok: false,
    error_code: 400,
    description: "Bad Request: can't parse entities",
  }), { status: 400 }) });
  assert.equal(badEntities.reason, "unsupported_content");
});

test("Telegram doctor checks bot and target without sendMessage", async () => {
  const methods = [];
  const result = await diagnoseTelegram({ token, channel, fetchImpl: async (url) => {
    methods.push(url.split("/").at(-1));
    return new Response(JSON.stringify(methods.length === 1 ? { ok: true, result: { is_bot: true } } : { ok: true, result: { id: -1 } }), { status: 200 });
  } });
  assert.deepEqual(result, { status: "passed", reason: "ok" });
  assert.deepEqual(methods, ["getMe", "getChat"]);
});

test("Telegram discovery returns only verified chat IDs and types", async () => {
  const methods = [];
  const result = await discoverTelegramChats({ token, fetchImpl: async (url) => {
    const method = url.split("/").at(-1);
    methods.push(method);
    if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "" } }), { status: 200 });
    if (method === "getUpdates") return new Response(JSON.stringify({ ok: true, result: [
      { update_id: 1, message: { text: "must-not-leak", chat: { id: -1001234567890, type: "supergroup", title: "must-not-leak" } } },
    ] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { id: -1001234567890, type: "supergroup" } }), { status: 200 });
  } });
  assert.deepEqual(result, { status: "passed", reason: "candidates_found", candidates: [{ chat_id: "-1001234567890", type: "supergroup" }] });
  assert.deepEqual(methods, ["getWebhookInfo", "getUpdates", "getChat"]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("Telegram discovery refuses getUpdates when a webhook is active", async () => {
  let calls = 0;
  const result = await discoverTelegramChats({ token, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true, result: { url: "https://example.invalid/hook" } }), { status: 200 });
  } });
  assert.deepEqual(result, { status: "blocked", reason: "webhook_active", candidates: [] });
  assert.equal(calls, 1);
});

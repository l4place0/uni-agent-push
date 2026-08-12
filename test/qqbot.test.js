import test from "node:test";
import assert from "node:assert/strict";
import { clearQQTokenCache, diagnoseQQBot, prepareQQBot, sendQQBot } from "../src/providers/qqbot.js";

const connection = { provider: "qqbot", app_id: "102000001", client_secret: "store:qq-main" };
const channel = { provider: "qqbot", target: { type: "group", openid: "opaque-group-id" } };
const message = { title: "Done", body: "Build finished", format: "markdown", priority: "normal" };

test("QQ Bot uses current token and group message endpoints with token cache", async () => {
  clearQQTokenCache();
  const prepared = prepareQQBot({ channel, message });
  assert.equal(prepared.endpoint, "https://api.bot.qq.com/v2/groups/opaque-group-id/messages");
  assert.deepEqual(prepared.body, { msg_type: 2, markdown: { content: "## Done\n\nBuild finished" } });
  let tokenCalls = 0;
  let messageCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("getAppAccessToken")) {
      tokenCalls += 1;
      assert.deepEqual(JSON.parse(init.body), { appId: connection.app_id, clientSecret: "qq-secret" });
      return new Response(JSON.stringify({ access_token: "access-secret", expires_in: "7200" }), { status: 200 });
    }
    messageCalls += 1;
    assert.equal(init.headers.authorization, "QQBot access-secret");
    return new Response(JSON.stringify({ id: `message-${messageCalls}` }), { status: 200 });
  };
  const first = await sendQQBot({ connection, clientSecret: "qq-secret", prepared, fetchImpl });
  const second = await sendQQBot({ connection, clientSecret: "qq-secret", prepared, fetchImpl });
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "accepted");
  assert.equal(tokenCalls, 1);
  assert.equal(messageCalls, 2);
  assert.equal(JSON.stringify(first).includes("access-secret"), false);
});

test("QQ Bot maps provider rate limit and ambiguous send", async () => {
  clearQQTokenCache();
  const prepared = prepareQQBot({ channel, message });
  let calls = 0;
  const limited = await sendQQBot({ connection, clientSecret: "qq-secret", prepared, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ access_token: "token", expires_in: 7200 }), { status: 200 });
    return new Response(JSON.stringify({ err_code: 40034100, message: "secret details" }), { status: 429 });
  } });
  assert.deepEqual(limited, { status: "rejected", reason: "rate_limited", transformations: ["title_prefixed_to_body"] });

  clearQQTokenCache();
  calls = 0;
  const timeout = new Error("timeout"); timeout.name = "TimeoutError";
  const uncertain = await sendQQBot({ connection, clientSecret: "qq-secret", prepared, fetchImpl: async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ access_token: "token", expires_in: 7200 }), { status: 200 });
    throw timeout;
  } });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.reason, "timeout_after_send");
  assert.equal(calls, 2);
});

test("QQ Bot doctor only obtains access token", async () => {
  clearQQTokenCache();
  let calls = 0;
  const result = await diagnoseQQBot({ connection, clientSecret: "qq-secret", fetchImpl: async (url) => {
    calls += 1;
    assert.equal(url, "https://api.bot.qq.com/app/getAppAccessToken");
    return new Response(JSON.stringify({ access_token: "token", expires_in: 7200 }), { status: 200 });
  } });
  assert.deepEqual(result, { status: "passed", reason: "ok" });
  assert.equal(calls, 1);
});

test("QQ Bot token cache is isolated when a credential is replaced", async () => {
  clearQQTokenCache();
  const prepared = prepareQQBot({ channel, message });
  let tokenCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("getAppAccessToken")) {
      tokenCalls += 1;
      const { clientSecret } = JSON.parse(init.body);
      return new Response(JSON.stringify({ access_token: `token-${clientSecret}`, expires_in: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "message-id" }), { status: 200 });
  };
  await sendQQBot({ connection, clientSecret: "first-secret", prepared, fetchImpl });
  await sendQQBot({ connection, clientSecret: "replacement-secret", prepared, fetchImpl });
  assert.equal(tokenCalls, 2);
});

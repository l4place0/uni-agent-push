import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../src/config.js";

test("minimal ServerChan config validates", () => {
  assert.deepEqual(validateConfig(defaultConfig()), []);
});

test("literal secrets and unsupported providers are rejected", () => {
  const literal = defaultConfig();
  literal.connections["serverchan-main"].send_key = "SCTliteral";
  assert.equal(validateConfig(literal).some((item) => item.code === "secret_reference_invalid"), true);

  const unsupported = defaultConfig();
  unsupported.connections["serverchan-main"].provider = "slack";
  assert.equal(validateConfig(unsupported).some((item) => item.code === "unsupported_provider"), true);
});

test("broken graph references are rejected", () => {
  const value = defaultConfig();
  value.channels["serverchan.owner"].connection = "missing";
  assert.equal(validateConfig(value).some((item) => item.code === "unknown_connection"), true);
});

test("Telegram and QQ Bot config shapes validate", () => {
  const telegram = {
    version: 1,
    connections: { "telegram-main": { provider: "telegram", token: "store:telegram-main" } },
    channels: { "telegram.owner": { provider: "telegram", connection: "telegram-main", chat_id: "-1001234567890" } },
    targets: { owner: { channels: ["telegram.owner"], policy: "single" } },
  };
  assert.deepEqual(validateConfig(telegram), []);
  const qq = {
    version: 1,
    connections: { "qq-main": { provider: "qqbot", app_id: "102000001", client_secret: "store:qq-main" } },
    channels: { "qq.owner": { provider: "qqbot", connection: "qq-main", target: { type: "user", openid: "opaque-user-openid" } } },
    targets: { owner: { channels: ["qq.owner"], policy: "single" } },
  };
  assert.deepEqual(validateConfig(qq), []);
  qq.channels["qq.owner"].target.openid = "123456789";
  assert.equal(validateConfig(qq).some((item) => item.path.endsWith("/target")), true);
});

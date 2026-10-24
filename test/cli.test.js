import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfigPath, main, resolveOnboardConfig } from "../src/cli.js";
import { defaultConfig, saveConfig } from "../src/config.js";
import { saveStoredSecret } from "../src/secrets.js";
import { clearQQTokenCache } from "../src/providers/qqbot.js";
import { config, request } from "../test-support/fixtures.js";

function sink() {
  let text = "";
  return { stream: { write(chunk) { text += chunk; } }, text: () => text };
}

test("CLI version is machine-readable", async () => {
  const output = sink();
  assert.equal(await main(["--version"], { stdout: output.stream, stderr: sink().stream }), 0);
  assert.deepEqual(JSON.parse(output.text()), {
    schema_version: 1,
    command: "version",
    status: "ok",
    version: "0.1.0",
  });
});

test("CLI dry-run writes exactly one JSON line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const requestPath = join(directory, "request.json");
  await writeFile(configPath, JSON.stringify(config()));
  await writeFile(requestPath, JSON.stringify(request()));
  const output = sink();
  const errors = sink();
  const exitCode = await main(
    ["send", "--config", configPath, "--request", requestPath, "--dry-run", "--json"],
    { stdout: output.stream, stderr: errors.stream, env: {}, fetchImpl: async () => { throw new Error("must not call"); } },
  );
  assert.equal(exitCode, 0);
  assert.equal(output.text().split("\n").filter(Boolean).length, 1);
  assert.equal(JSON.parse(output.text()).status, "ready");
  assert.equal(errors.text(), "");
});

test("CLI real send returns accepted receipt without secret data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const requestPath = join(directory, "request.json");
  await writeFile(configPath, JSON.stringify(config()));
  await writeFile(requestPath, JSON.stringify(request()));
  const output = sink();
  const exitCode = await main(
    ["send", "--config", configPath, "--request", requestPath, "--json"],
    {
      stdout: output.stream,
      stderr: sink().stream,
      env: { SERVERCHAN_SEND_KEY: "SCTsupersecret" },
      fetchImpl: async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    },
  );
  assert.equal(exitCode, 0);
  const receipt = JSON.parse(output.text());
  assert.equal(receipt.status, "accepted");
  assert.equal(output.text().includes("SCTsupersecret"), false);
  assert.equal(output.text().includes("Test complete"), false);
});

test("onboard resolves a conventional config path and starts guided UI", async () => {
  assert.equal(
    defaultConfigPath({}, { home: "/users/demo", platform: "linux" }),
    "/users/demo/.config/uni-push/config.json",
  );
  assert.equal(
    resolveOnboardConfig({}, { XDG_CONFIG_HOME: "/var/demo" }, { home: "/ignored", platform: "linux" }),
    "/var/demo/uni-push/config.json",
  );
  assert.equal(
    resolveOnboardConfig({ config: "custom.json" }, { UNI_PUSH_CONFIG: "/ignored.json" }),
    join(process.cwd(), "custom.json"),
  );

  const output = sink();
  let started;
  const exitCode = await main(["onboard", "--no-open"], {
    stdout: output.stream,
    stderr: sink().stream,
    env: {},
    runtime: { home: "/users/demo", platform: "linux" },
    startUi: async (options) => {
      started = options;
      return { url: "http://127.0.0.1:1234/#session=test", server: { close() {} }, closed: Promise.resolve() };
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(started.mode, "onboard");
  assert.equal(started.openBrowser, false);
  assert.equal(started.configPath, "/users/demo/.config/uni-push/config.json");
  assert.match(output.text(), /Uni Push onboarding/);
  assert.match(output.text(), /\/users\/demo\/\.config\/uni-push\/config\.json/);
});

test("doctor resolves stored credential without exposing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-doctor-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const secret = "SCTdoctor-stored";
  await saveConfig(configPath, defaultConfig());
  await saveStoredSecret(configPath, "serverchan-main", secret);
  const output = sink();
  const exitCode = await main(["doctor", "--config", configPath, "--json"], {
    stdout: output.stream,
    stderr: sink().stream,
    env: {},
  });
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output.text()).status, "passed");
  assert.equal(output.text().includes(secret), false);
});

test("CLI doctor and inventory cover Telegram and QQ Bot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "uni-push-cli-providers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const telegramPath = join(directory, "telegram.json");
  const telegram = {
    version: 1,
    connections: { "telegram-main": { provider: "telegram", token: "store:telegram-main" } },
    channels: { "telegram.owner": { provider: "telegram", connection: "telegram-main", chat_id: "-1001234567890" } },
    targets: { owner: { channels: ["telegram.owner"], policy: "single" } },
  };
  await saveConfig(telegramPath, telegram);
  await saveStoredSecret(telegramPath, "telegram-main", "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd");
  const telegramDoctor = sink();
  let telegramCalls = 0;
  const telegramExit = await main(["doctor", "--config", telegramPath, "--json"], {
    stdout: telegramDoctor.stream, stderr: sink().stream, env: {}, fetchImpl: async () => {
      telegramCalls += 1;
      return new Response(JSON.stringify(telegramCalls === 1 ? { ok: true, result: { is_bot: true } } : { ok: true, result: { id: -1 } }), { status: 200 });
    },
  });
  assert.equal(telegramExit, 0);
  assert.equal(JSON.parse(telegramDoctor.text()).status, "passed");
  assert.equal(telegramCalls, 2);

  clearQQTokenCache();
  const qqPath = join(directory, "qq.json");
  const qq = {
    version: 1,
    connections: { "qq-main": { provider: "qqbot", app_id: "cli-doctor-app", client_secret: "store:qq-main" } },
    channels: { "qq.owner": { provider: "qqbot", connection: "qq-main", target: { type: "user", openid: "opaque-user" } } },
    targets: { owner: { channels: ["qq.owner"], policy: "single" } },
  };
  await saveConfig(qqPath, qq);
  await saveStoredSecret(qqPath, "qq-main", "qq-client-secret");
  const qqDoctor = sink();
  const qqExit = await main(["doctor", "--config", qqPath, "--json"], {
    stdout: qqDoctor.stream, stderr: sink().stream, env: {},
    fetchImpl: async () => new Response(JSON.stringify({ access_token: "access", expires_in: 7200 }), { status: 200 }),
  });
  assert.equal(qqExit, 0);
  assert.equal(JSON.parse(qqDoctor.text()).status, "passed");

  const inventory = sink();
  assert.equal(await main(["channels", "--config", qqPath, "--json"], { stdout: inventory.stream, stderr: sink().stream, env: {} }), 0);
  assert.equal(JSON.parse(inventory.text()).channels[0].provider, "qqbot");
  assert.equal(inventory.text().includes("opaque-user"), false);
});

test("CLI offline recovery requires assertion and emits machine-readable result", async (t) => {
 const directory = await mkdtemp(join(tmpdir(), "uni-push-recover-"));
 t.after(() => rm(directory, { recursive: true, force: true }));
 const path = join(directory, "ledger.json");
 await writeFile(`${path}.lock`, "");
 assert.equal(await main(["ledger", "recover-lock", "--ledger", path], { stdout: sink().stream, stderr: sink().stream }), 20);
 const output = sink();
 assert.equal(await main(["ledger", "recover-lock", "--ledger", path, "--writers-stopped", "--json"], { stdout: output.stream, stderr: sink().stream }), 0);
 assert.equal(JSON.parse(output.text()).recovered, true);
});

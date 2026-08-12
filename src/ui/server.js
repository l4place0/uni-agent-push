import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertValidConfig, defaultConfig, saveConfig, validateConfig } from "../config.js";
import { UniPushError } from "../errors.js";
import { classifySendKey, prepareServerChan, sendPreparedServerChan } from "../providers/serverchan.js";
import { diagnoseTelegram, discoverTelegramChats, prepareTelegram, sendPreparedTelegram, validateTelegramToken } from "../providers/telegram.js";
import { diagnoseQQBot, prepareQQBot, sendQQBot } from "../providers/qqbot.js";
import { resolveRoute } from "../request.js";
import { hasStoredSecret, resolveSecret, saveStoredSecret, storedSecretId } from "../secrets.js";

const assetDefinitions = {
  "/": { key: "ui/index.html", file: new URL("./public/index.html", import.meta.url), type: "text/html; charset=utf-8" },
  "/app.js": { key: "ui/app.js", file: new URL("./public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" },
  "/style.css": { key: "ui/style.css", file: new URL("./public/style.css", import.meta.url), type: "text/css; charset=utf-8" },
};

async function readAsset(asset) {
  if (globalThis.__UNI_PUSH_UI_ASSETS__?.[asset.key] !== undefined) {
    return Buffer.from(globalThis.__UNI_PUSH_UI_ASSETS__[asset.key]);
  }
  if (process.env.NODE_SEA === "1") {
    const { getAsset } = await import("node:sea");
    return Buffer.from(getAsset(asset.key));
  }
  return readFile(fileURLToPath(asset.file));
}

function secureHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function json(response, status, value) {
  secureHeaders(response);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function authorized(request, token) {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function bodyJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function launchBrowser(url) {
  const command = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    spawn(command[0], command[1], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

async function loadUiConfig(path) {
  try {
    return assertValidConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return defaultConfig();
    throw error;
  }
}

function secretReference(connection) {
  return connection.send_key ?? connection.token ?? connection.client_secret;
}

function validateCredential(connection, value) {
  if (connection.provider === "serverchan") return classifySendKey(value);
  if (connection.provider === "telegram") return validateTelegramToken(value);
  if (connection.provider === "qqbot" && typeof value === "string" && value.length >= 8 && value.length <= 4096) return value;
  throw new UniPushError("configuration_invalid", "Credential is invalid", 21);
}

async function credentialStates(config, configPath, env) {
  const states = {};
  for (const [name, connection] of Object.entries(config.connections)) {
    const reference = secretReference(connection);
    const storedId = storedSecretId(reference);
    states[name] = storedId
      ? { source: "store", configured: await hasStoredSecret(configPath, storedId) }
      : { source: "env", configured: Boolean(env[reference.slice(4)]) };
  }
  return states;
}

async function checkConfig(config, env, configPath, fetchImpl) {
  const issues = validateConfig(config);
  if (issues.length) return { status: "failed", checks: [{ check: "configuration", status: "failed", reason: "configuration_invalid" }], issues };
  const checks = [{ check: "configuration", status: "passed", reason: "ok" }];
  for (const [name, channel] of Object.entries(config.channels)) {
    try {
      const connection = config.connections[channel.connection];
      const secret = await resolveSecret(secretReference(connection), { env, configPath });
      let result = { status: "passed", reason: "ok" };
      if (channel.provider === "serverchan") prepareServerChan({ sendKey: secret, channel, message: { title: "check", body: "check" } });
      if (channel.provider === "telegram") result = await diagnoseTelegram({ token: secret, channel, fetchImpl });
      if (channel.provider === "qqbot") result = await diagnoseQQBot({ connection, clientSecret: secret, fetchImpl });
      checks.push({ check: "provider_access", subject: name, status: result.status, reason: result.reason });
    } catch {
      checks.push({ check: "secret_and_options", subject: name, status: "failed", reason: "secret_unavailable_invalid_or_incompatible" });
    }
  }
  return { status: checks.some((check) => check.status === "failed") ? "failed" : "passed", checks };
}

async function performTest(config, env, fetchImpl, configPath) {
  assertValidConfig(config);
  const targetName = Object.keys(config.targets)[0];
  const route = resolveRoute(config, { kind: "target", name: targetName });
  const message = {
    title: "Uni Push 配置成功",
    body: "这是一条经你在 Onboarding 中明确确认发送的测试通知。",
    format: "plain",
    priority: "normal",
  };
  const secret = await resolveSecret(secretReference(route.connection), { env, configPath });
  let result;
  if (route.channel.provider === "serverchan") {
    result = await sendPreparedServerChan(prepareServerChan({ sendKey: secret, channel: route.channel, message }), { fetchImpl });
  } else if (route.channel.provider === "telegram") {
    result = await sendPreparedTelegram(prepareTelegram({ token: secret, channel: route.channel, message }), { fetchImpl });
  } else {
    result = await sendQQBot({ connection: route.connection, clientSecret: secret, prepared: prepareQQBot({ channel: route.channel, message }), fetchImpl });
  }
  return { status: result.status, reason: result.reason };
}

export async function startConfigUi({
  configPath,
  openBrowser = false,
  mode = "config",
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const token = randomBytes(32).toString("base64url");
  let origin;
  let testResultPromise;
  let testResultKey;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== origin.replace("http://", "")) {
        json(response, 403, { error: "request_forbidden" });
        return;
      }
      const url = new URL(request.url, origin);
      const asset = assetDefinitions[url.pathname];
      if (request.method === "GET" && asset) {
        const content = await readAsset(asset);
        secureHeaders(response);
        response.writeHead(200, { "content-type": asset.type });
        response.end(content);
        return;
      }
      if (!url.pathname.startsWith("/api/") || !authorized(request, token)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        const config = await loadUiConfig(configPath);
        json(response, 200, { config, credentials: await credentialStates(config, configPath, env) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, { mode, config_path: configPath });
        return;
      }
      if (request.method === "POST") {
        if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") {
          json(response, 403, { error: "request_forbidden" });
          return;
        }
        if (url.pathname === "/api/validate") {
          const config = await bodyJson(request);
          const issues = validateConfig(config);
          json(response, 200, { valid: issues.length === 0, issues });
          return;
        }
        if (url.pathname === "/api/save") {
          const input = await bodyJson(request);
          const config = input.config ?? input;
          const issues = validateConfig(config);
          if (issues.length > 0) {
            json(response, 400, { saved: false, issues });
            return;
          }
          const storedIds = Object.values(config.connections).map((connection) => storedSecretId(secretReference(connection))).filter(Boolean);
          const credential = input.credential;
          if (credential?.value) {
            if (!storedIds.includes(credential.id)) {
              json(response, 400, { saved: false, error: "credential_reference_mismatch" });
              return;
            }
            const connection = Object.values(config.connections).find((item) => storedSecretId(secretReference(item)) === credential.id);
            validateCredential(connection, credential.value);
            await saveStoredSecret(configPath, credential.id, credential.value);
          }
          for (const id of storedIds) {
            if (!(await hasStoredSecret(configPath, id))) {
              json(response, 400, { saved: false, error: "credential_required" });
              return;
            }
          }
          await saveConfig(configPath, config);
          testResultPromise = undefined;
          testResultKey = undefined;
          json(response, 200, { saved: true });
          return;
        }
        if (url.pathname === "/api/check") {
          const input = await bodyJson(request);
          const config = input.config ?? input;
          json(response, 200, await checkConfig(config, env, configPath, fetchImpl));
          return;
        }
        if (url.pathname === "/api/discover/telegram") {
          const body = await bodyJson(request);
          const config = body.config;
          const connection = Object.values(config?.connections ?? {}).find((item) => item?.provider === "telegram");
          if (!connection) {
            json(response, 400, { error: "telegram_connection_required" });
            return;
          }
          let telegramToken;
          if (typeof body.credential === "string" && body.credential) {
            telegramToken = validateTelegramToken(body.credential);
          } else {
            telegramToken = await resolveSecret(secretReference(connection), { env, configPath });
          }
          json(response, 200, await discoverTelegramChats({ token: telegramToken, fetchImpl }));
          return;
        }
        if (url.pathname === "/api/test") {
          if (mode !== "onboard") {
            json(response, 404, { error: "not_found" });
            return;
          }
          const body = await bodyJson(request);
          if (body.confirmed !== true) {
            json(response, 400, { error: "explicit_confirmation_required" });
            return;
          }
          const key = JSON.stringify(body.config);
          if (testResultKey !== key) {
            testResultKey = key;
            testResultPromise = undefined;
          }
          const replayed = testResultPromise !== undefined;
          testResultPromise ??= performTest(body.config, env, fetchImpl, configPath).catch((error) => {
            testResultPromise = undefined;
            testResultKey = undefined;
            throw error;
          });
          const result = await testResultPromise;
          json(response, 200, { ...result, replayed });
          return;
        }
        if (url.pathname === "/api/shutdown") {
          json(response, 200, { shutting_down: true });
          setImmediate(() => server.close());
          return;
        }
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      json(response, 400, { error: error instanceof UniPushError ? error.code : "invalid_request" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/#session=${token}`;
  if (openBrowser) launchBrowser(url);
  return {
    server,
    origin,
    url,
    token,
    close: () => new Promise((resolve) => server.close(resolve)),
    closed: new Promise((resolve) => server.once("close", resolve)),
  };
}

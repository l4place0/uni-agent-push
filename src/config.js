import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UniPushError } from "./errors.js";
import { validSecretReference } from "./secrets.js";

const NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(path, code) {
  return { severity: "error", code, path };
}

function extraKeys(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(`${path}/${key}`, "invalid_schema"));
  }
}

export function validateConfig(config) {
  const issues = [];
  if (!object(config)) return [issue("", "invalid_schema")];
  extraKeys(config, new Set(["version", "connections", "channels", "targets"]), "", issues);
  if (config.version !== 1) issues.push(issue("/version", "unsupported_config_version"));

  for (const section of ["connections", "channels", "targets"]) {
    if (!object(config[section]) || Object.keys(config[section]).length === 0) {
      issues.push(issue(`/${section}`, "invalid_schema"));
    }
  }
  if (issues.length > 0 && (!object(config.connections) || !object(config.channels) || !object(config.targets))) {
    return issues;
  }

  for (const [name, connection] of Object.entries(config.connections ?? {})) {
    const path = `/connections/${name}`;
    if (!NAME.test(name) || !object(connection)) {
      issues.push(issue(path, "invalid_schema"));
      continue;
    }
    if (connection.provider === "serverchan") {
      extraKeys(connection, new Set(["provider", "send_key"]), path, issues);
      if (!validSecretReference(connection.send_key)) issues.push(issue(`${path}/send_key`, "secret_reference_invalid"));
    } else if (connection.provider === "telegram") {
      extraKeys(connection, new Set(["provider", "token"]), path, issues);
      if (!validSecretReference(connection.token)) issues.push(issue(`${path}/token`, "secret_reference_invalid"));
    } else if (connection.provider === "qqbot") {
      extraKeys(connection, new Set(["provider", "app_id", "client_secret"]), path, issues);
      if (typeof connection.app_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(connection.app_id)) issues.push(issue(`${path}/app_id`, "invalid_schema"));
      if (!validSecretReference(connection.client_secret)) issues.push(issue(`${path}/client_secret`, "secret_reference_invalid"));
    } else {
      issues.push(issue(`${path}/provider`, "unsupported_provider"));
    }
  }

  for (const [name, channel] of Object.entries(config.channels ?? {})) {
    const path = `/channels/${name}`;
    if (!NAME.test(name) || !object(channel)) {
      issues.push(issue(path, "invalid_schema"));
      continue;
    }
    if (channel.provider === "serverchan") {
      extraKeys(channel, new Set(["provider", "connection", "delivery_channels", "hide_caller_ip"]), path, issues);
    } else if (channel.provider === "telegram") {
      extraKeys(channel, new Set(["provider", "connection", "chat_id", "message_thread_id", "disable_link_preview", "silent", "protect_content"]), path, issues);
      if (typeof channel.chat_id !== "string" || !/^(?:-?[0-9]+|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(channel.chat_id)) issues.push(issue(`${path}/chat_id`, "invalid_schema"));
      if (channel.message_thread_id !== undefined && (!Number.isInteger(channel.message_thread_id) || channel.message_thread_id < 1)) issues.push(issue(`${path}/message_thread_id`, "invalid_schema"));
      for (const option of ["disable_link_preview", "silent", "protect_content"]) {
        if (channel[option] !== undefined && typeof channel[option] !== "boolean") issues.push(issue(`${path}/${option}`, "invalid_schema"));
      }
    } else if (channel.provider === "qqbot") {
      extraKeys(channel, new Set(["provider", "connection", "target"]), path, issues);
      if (!object(channel.target) || !["group", "user"].includes(channel.target?.type) || typeof channel.target?.openid !== "string" || channel.target.openid.length < 1 || channel.target.openid.length > 256 || /^[0-9]+$/.test(channel.target.openid)) {
        issues.push(issue(`${path}/target`, "invalid_schema"));
      }
    } else {
      issues.push(issue(`${path}/provider`, "unsupported_provider"));
    }
    if (typeof channel.connection !== "string" || !config.connections?.[channel.connection]) {
      issues.push(issue(`${path}/connection`, "unknown_connection"));
    } else if (config.connections[channel.connection].provider !== channel.provider) {
      issues.push(issue(`${path}/connection`, "connection_provider_mismatch"));
    }
    if (channel.provider === "serverchan" && channel.delivery_channels !== undefined) {
      if (
        !Array.isArray(channel.delivery_channels) ||
        channel.delivery_channels.length === 0 ||
        channel.delivery_channels.length > 16 ||
        new Set(channel.delivery_channels).size !== channel.delivery_channels.length ||
        channel.delivery_channels.some((item) => typeof item !== "string" || item.length === 0 || /[|\r\n]/.test(item))
      ) {
        issues.push(issue(`${path}/delivery_channels`, "invalid_schema"));
      }
    }
    if (channel.provider === "serverchan" && channel.hide_caller_ip !== undefined && typeof channel.hide_caller_ip !== "boolean") {
      issues.push(issue(`${path}/hide_caller_ip`, "invalid_schema"));
    }
  }

  for (const [name, target] of Object.entries(config.targets ?? {})) {
    const path = `/targets/${name}`;
    if (!NAME.test(name) || !object(target)) {
      issues.push(issue(path, "invalid_schema"));
      continue;
    }
    extraKeys(target, new Set(["channels", "policy"]), path, issues);
    if (target.policy !== "single") issues.push(issue(`${path}/policy`, "unsupported_policy"));
    if (!Array.isArray(target.channels) || target.channels.length !== 1) {
      issues.push(issue(`${path}/channels`, "unsupported_policy"));
    } else if (!config.channels?.[target.channels[0]]) {
      issues.push(issue(`${path}/channels/0`, "unknown_channel"));
    }
  }
  return issues;
}

export function assertValidConfig(config) {
  const issues = validateConfig(config);
  if (issues.length > 0) {
    const error = new UniPushError("configuration_invalid", "Configuration is invalid", 21);
    error.issues = issues;
    throw error;
  }
  return config;
}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UniPushError("configuration_unavailable", "Configuration is unavailable", 21);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new UniPushError("configuration_invalid", "Configuration is not valid JSON", 21);
  }
  return assertValidConfig(config);
}

export async function saveConfig(path, config) {
  assertValidConfig(config);
  const temporary = join(dirname(path), `.uni-push-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw new UniPushError("config_write_failed", "Unable to save configuration", 21);
  }
}

export function defaultConfig() {
  return {
    version: 1,
    connections: {
      "serverchan-main": { provider: "serverchan", send_key: "store:serverchan-main" },
    },
    channels: {
      "serverchan.owner": { provider: "serverchan", connection: "serverchan-main" },
    },
    targets: {
      owner: { channels: ["serverchan.owner"], policy: "single" },
    },
  };
}

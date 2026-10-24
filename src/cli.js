import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { classifySendKey } from "./providers/serverchan.js";
import { diagnoseTelegram } from "./providers/telegram.js";
import { diagnoseQQBot } from "./providers/qqbot.js";
import { loadConfig, validateConfig } from "./config.js";
import { publicError, UniPushError } from "./errors.js";
import { recoverLedgerLock } from "./ledger.js";
import { sendNotification } from "./send.js";
import { startConfigUi } from "./ui/server.js";
import { resolveSecret } from "./secrets.js";

export const CLI_VERSION = "0.1.0";

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) throw new UniPushError("invalid_cli_usage", "Unexpected positional argument", 20);
    const name = item.slice(2);
    if (["json", "dry-run", "no-open", "writers-stopped"].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new UniPushError("invalid_cli_usage", `Missing value for --${name}`, 20);
    if (options[name] !== undefined) throw new UniPushError("invalid_cli_usage", `Repeated --${name}`, 20);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(path) {
  let text;
  try {
    text = path === "-" ? await stdinText() : await readFile(path, "utf8");
  } catch {
    throw new UniPushError("invalid_cli_usage", "Unable to read JSON input", 20);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UniPushError("invalid_json", "Input is not valid JSON", 20);
  }
}

function emit(stdout, value) {
  stdout.write(`${JSON.stringify(value)}\n`);
}

function receiptExitCode(receipt) {
  return { accepted: 0, rejected: 10, uncertain: 11, partial: 12 }[receipt.status] ?? 0;
}

function requireOption(options, name) {
  if (!options[name]) throw new UniPushError("invalid_cli_usage", `--${name} is required`, 20);
  return resolve(options[name]);
}

function requireConfig(options, env) {
  const value = options.config ?? env.UNI_PUSH_CONFIG;
  if (!value) throw new UniPushError("invalid_cli_usage", "--config or UNI_PUSH_CONFIG is required", 20);
  return resolve(value);
}

export function defaultConfigPath(env = process.env, { home = homedir(), platform = process.platform } = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  if (platform === "win32") return pathApi.join(env.APPDATA || pathApi.join(home, "AppData", "Roaming"), "uni-push", "config.json");
  return pathApi.join(env.XDG_CONFIG_HOME || pathApi.join(home, ".config"), "uni-push", "config.json");
}

export function resolveOnboardConfig(options, env = process.env, runtime = {}) {
  const explicit = options.config ?? env.UNI_PUSH_CONFIG;
  return explicit ? resolve(explicit) : defaultConfigPath(env, runtime);
}

async function validateCommand(configPath) {
  let config;
  try {
    config = await readJson(configPath);
  } catch (error) {
    if (error.code === "invalid_json") {
      return { result: { schema_version: 1, command: "config_validate", status: "invalid", issues: [{ severity: "error", code: "invalid_json", path: "" }] }, exitCode: 21 };
    }
    throw error;
  }
  const issues = validateConfig(config);
  return {
    result: { schema_version: 1, command: "config_validate", status: issues.length ? "invalid" : "valid", issues },
    exitCode: issues.length ? 21 : 0,
  };
}

function targetsResult(config) {
  return {
    schema_version: 1,
    command: "targets",
    status: "ok",
    targets: Object.entries(config.targets).sort(([a], [b]) => a.localeCompare(b)).map(([name, target]) => ({
      name,
      policy: target.policy,
      channels: target.channels,
      providers: [...new Set(target.channels.map((channel) => config.channels[channel]?.provider).filter(Boolean))].sort(),
    })),
  };
}

function channelsResult(config) {
  return {
    schema_version: 1,
    command: "channels",
    status: "ok",
    channels: Object.entries(config.channels).sort(([a], [b]) => a.localeCompare(b)).map(([name, channel]) => ({
      name,
      provider: channel.provider,
      delivery_shape: channel.provider === "telegram" ? "telegram_chat" : channel.provider === "qqbot" ? `qq_${channel.target.type}` : "serverchan_personal",
      acceptance_scope: "provider_api_only",
      formats: ["markdown", "plain"],
      configured_options: [
        ...(channel.delivery_channels ? ["delivery_channels"] : []),
        ...(channel.hide_caller_ip ? ["caller_ip_hidden"] : []),
        ...(channel.message_thread_id ? ["message_thread"] : []),
        ...(channel.disable_link_preview ? ["link_preview_disabled"] : []),
        ...(channel.silent ? ["silent"] : []),
        ...(channel.protect_content ? ["protected"] : []),
      ].sort(),
    })),
  };
}

async function doctorResult(config, env, configPath, fetchImpl) {
  const checks = [{ scope: "configuration", subject: "configuration", check: "configuration", status: "passed", reason: "ok" }];
  for (const [channelName, channel] of Object.entries(config.channels).sort(([a], [b]) => a.localeCompare(b))) {
    const connection = config.connections[channel.connection];
    try {
      const reference = connection.send_key ?? connection.token ?? connection.client_secret;
      const secret = await resolveSecret(reference, { env, configPath });
      checks.push({ scope: "connection", subject: channel.connection, provider: channel.provider, check: "secret_availability", status: "passed", reason: "ok" });
      if (channel.provider === "serverchan") {
        classifySendKey(secret);
        checks.push({ scope: "connection", subject: channel.connection, provider: channel.provider, check: "secret_format", status: "passed", reason: "ok" });
      } else {
        const diagnostic = channel.provider === "telegram"
          ? await diagnoseTelegram({ token: secret, channel, fetchImpl })
          : await diagnoseQQBot({ connection, clientSecret: secret, fetchImpl });
        checks.push({ scope: "channel", subject: channelName, provider: channel.provider, check: "provider_access", status: diagnostic.status, reason: diagnostic.reason });
      }
    } catch {
      checks.push({ scope: "channel", subject: channelName, provider: channel.provider, check: "provider_access", status: "failed", reason: "secret_unavailable" });
    }
  }
  const failed = checks.filter((check) => check.status === "failed").length;
  return {
    result: {
      schema_version: 1,
      command: "doctor",
      status: failed ? "failed" : "passed",
      summary: { passed: checks.length - failed, failed, warning: 0, skipped: 0 },
      checks,
    },
    exitCode: failed ? 30 : 0,
  };
}

export async function main(args, {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  fetchImpl = fetch,
  startUi = startConfigUi,
  runtime = {},
} = {}) {
  let notificationId;
  try {
    const [command, maybeSubcommand, ...rest] = args;
    if (!command) throw new UniPushError("invalid_cli_usage", "A command is required", 20);

    if (["--version", "version"].includes(command)) {
      emit(stdout, { schema_version: 1, command: "version", status: "ok", version: CLI_VERSION });
      return 0;
    }

    if (command === "ledger" && maybeSubcommand === "recover-lock") {
      const options = parseOptions(rest);
      const path = options.ledger ? resolve(options.ledger) : `${requireConfig(options, env)}.ledger.json`;
      const result = recoverLedgerLock(path, { writersStopped: options["writers-stopped"] === true });
      emit(stdout, { schema_version: 1, command: "ledger_recover_lock", status: "ok", ...result });
      return 0;
    }

    if (command === "send") {
      const options = parseOptions(args.slice(1));
      const configPath = requireConfig(options, env);
      const requestPath = requireOption(options, "request");
      const config = await loadConfig(configPath);
      const request = await readJson(requestPath);
      notificationId = request.notification_id;
      const receipt = await sendNotification({
        config,
        configPath,
        request,
        ledgerPath: options.ledger ? resolve(options.ledger) : `${configPath}.ledger.json`,
        dryRun: options["dry-run"] === true,
        env,
        fetchImpl,
      });
      emit(stdout, receipt);
      return receiptExitCode(receipt);
    }

    if (command === "config" && maybeSubcommand === "validate") {
      const options = parseOptions(rest);
      const outcome = await validateCommand(requireConfig(options, env));
      emit(stdout, outcome.result);
      return outcome.exitCode;
    }

    if (command === "config" && maybeSubcommand === "ui") {
      const options = parseOptions(rest);
      if (options.json) throw new UniPushError("invalid_cli_usage", "config ui is human-only", 20);
      const ui = await startUi({ configPath: requireConfig(options, env), openBrowser: !options["no-open"], env, fetchImpl, mode: "config" });
      stdout.write(`Uni Push configuration UI: ${ui.url}\n`);
      const stop = () => ui.server.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await ui.closed;
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      return 0;
    }

    if (command === "onboard") {
      const options = parseOptions(args.slice(1));
      if (options.json) throw new UniPushError("invalid_cli_usage", "onboard is human-only", 20);
      const configPath = resolveOnboardConfig(options, env, runtime);
      const ui = await startUi({ configPath, openBrowser: !options["no-open"], env, fetchImpl, mode: "onboard" });
      stdout.write(`Uni Push onboarding: ${ui.url}\nConfiguration: ${configPath}\n`);
      const stop = () => ui.server.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await ui.closed;
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      return 0;
    }

    if (["targets", "channels", "doctor"].includes(command)) {
      const options = parseOptions(args.slice(1));
      const config = await loadConfig(requireConfig(options, env));
      if (command === "targets") {
        emit(stdout, targetsResult(config));
        return 0;
      }
      if (command === "channels") {
        emit(stdout, channelsResult(config));
        return 0;
      }
      const configPath = requireConfig(options, env);
      const outcome = await doctorResult(config, env, configPath, fetchImpl);
      emit(stdout, outcome.result);
      return outcome.exitCode;
    }

    throw new UniPushError("invalid_cli_usage", "Unknown command", 20);
  } catch (error) {
    emit(stdout, publicError(error, notificationId));
    if (!(error instanceof UniPushError)) stderr.write("uni-push: internal error\n");
    return error instanceof UniPushError ? error.exitCode : 24;
  }
}

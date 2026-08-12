import { requestFingerprint } from "./canonical.js";
import { UniPushError } from "./errors.js";
import { Ledger } from "./ledger.js";
import { prepareServerChan, sendPreparedServerChan } from "./providers/serverchan.js";
import { prepareTelegram, sendPreparedTelegram } from "./providers/telegram.js";
import { prepareQQBot, sendQQBot } from "./providers/qqbot.js";
import { assertValidRequest, resolveRoute } from "./request.js";
import { resolveSecret } from "./secrets.js";

function dryRunResult(request, fingerprint, route) {
  const provider = route.channel.provider;
  const transformations = provider === "serverchan" ? [] : ["title_prefixed_to_body"];
  if (request.message.format === "markdown" && provider === "telegram") transformations.push("markdown_rendered_as_plain");
  if (request.message.url) transformations.push("url_appended_to_body");
  if (provider !== "serverchan" && request.message.summary) transformations.push("summary_omitted");
  if (provider !== "serverchan" && request.message.tags?.length) transformations.push("tags_omitted");
  return {
    schema_version: 1,
    operation: "dry_run",
    status: "ready",
    notification_id: request.notification_id,
    request_fingerprint: fingerprint,
    delivery_policy: "single",
    guarantees: {
      network_access: false,
      secrets_resolved: false,
      ledger_mutated: false,
      persistent_state_written: false,
    },
    attempts: [
      {
        order: 1,
        channel: route.channelName,
        provider,
        condition: "always",
        plan_completeness: "secret_dependent",
        acceptance_scope: "provider_api_only",
        output_format: request.message.format === "markdown" && provider === "qqbot" ? "provider_markdown" : "plain_text",
        transformations,
      },
    ],
    warnings: [
      "credentials_not_checked",
      "connectivity_not_checked",
      "secret_dependent_capabilities_not_checked",
    ],
  };
}

function deliveryReceipt(request, fingerprint, route, providerResult) {
  return {
    schema_version: 1,
    notification_id: request.notification_id,
    request_fingerprint: fingerprint,
    delivery_policy: "single",
    status: providerResult.status,
    attempts: [
      {
        channel: route.channelName,
        provider: route.channel.provider,
        status: providerResult.status,
        reason: providerResult.reason,
        acceptance_scope: "provider_api_only",
        transformations: providerResult.transformations,
      },
    ],
  };
}

export async function sendNotification({
  config,
  request,
  ledgerPath,
  configPath,
  dryRun = false,
  env = process.env,
  fetchImpl = fetch,
}) {
  assertValidRequest(request);
  const route = resolveRoute(config, request.destination);
  const fingerprint = requestFingerprint(request);
  if (dryRun) return dryRunResult(request, fingerprint, route);

  let prepared;
  let providerResult;
  let qqClientSecret;
  const provider = route.channel.provider;
  if (provider === "serverchan") {
    const sendKey = await resolveSecret(route.connection.send_key, { env, configPath });
    prepared = prepareServerChan({ sendKey, channel: route.channel, message: request.message });
  } else if (provider === "telegram") {
    const token = await resolveSecret(route.connection.token, { env, configPath });
    prepared = prepareTelegram({ token, channel: route.channel, message: request.message });
  } else if (provider === "qqbot") {
    qqClientSecret = await resolveSecret(route.connection.client_secret, { env, configPath });
    prepared = prepareQQBot({ channel: route.channel, message: request.message });
  } else {
    throw new UniPushError("configuration_invalid", "Unsupported provider", 21);
  }
  const ledger = new Ledger(ledgerPath);
  try {
    const claim = ledger.claim(request.notification_id, fingerprint);
    if (claim.kind === "conflict") throw new UniPushError("notification_conflict", "Notification ID already has different content", 23);
    if (claim.kind === "in_progress") throw new UniPushError("notification_in_progress", "Notification is already in progress", 23);
    if (claim.kind === "replay") return claim.receipt;

    if (provider === "serverchan") providerResult = await sendPreparedServerChan(prepared, { fetchImpl });
    if (provider === "telegram") providerResult = await sendPreparedTelegram(prepared, { fetchImpl });
    if (provider === "qqbot") {
      providerResult = await sendQQBot({ connection: route.connection, clientSecret: qqClientSecret, prepared, fetchImpl });
    }
    const receipt = deliveryReceipt(request, fingerprint, route, providerResult);
    ledger.complete(request.notification_id, fingerprint, receipt);
    return receipt;
  } finally {
    ledger.close();
  }
}

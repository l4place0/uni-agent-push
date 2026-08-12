import { UniPushError } from "./errors.js";

const NAME = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRequest(request) {
  const issues = [];
  if (!object(request)) return [{ path: "", code: "invalid_schema" }];
  if (request.schema_version !== 1) issues.push({ path: "/schema_version", code: "unsupported_schema_version" });
  if (typeof request.notification_id !== "string" || !ID.test(request.notification_id)) {
    issues.push({ path: "/notification_id", code: "invalid_schema" });
  }
  if (!object(request.destination) || !["target", "channel"].includes(request.destination.kind) || !NAME.test(request.destination.name ?? "")) {
    issues.push({ path: "/destination", code: "invalid_schema" });
  }
  const message = request.message;
  if (!object(message)) {
    issues.push({ path: "/message", code: "invalid_schema" });
  } else {
    if (typeof message.title !== "string" || message.title.length < 1 || message.title.length > 256 || /[\r\n]/.test(message.title)) {
      issues.push({ path: "/message/title", code: "invalid_schema" });
    }
    if (typeof message.body !== "string" || message.body.length < 1 || message.body.length > 16384) {
      issues.push({ path: "/message/body", code: "invalid_schema" });
    }
    if (!['plain', 'markdown'].includes(message.format)) issues.push({ path: "/message/format", code: "invalid_schema" });
    if (!['low', 'normal', 'high', 'critical'].includes(message.priority)) issues.push({ path: "/message/priority", code: "invalid_schema" });
    if (message.summary !== undefined && (typeof message.summary !== "string" || message.summary.length > 256 || /[\r\n]/.test(message.summary))) {
      issues.push({ path: "/message/summary", code: "invalid_schema" });
    }
    if (message.url !== undefined && (typeof message.url !== "string" || !message.url.startsWith("https://") || message.url.length > 2048)) {
      issues.push({ path: "/message/url", code: "invalid_schema" });
    }
    if (message.tags !== undefined && (!Array.isArray(message.tags) || message.tags.length > 16 || message.tags.some((tag) => typeof tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(tag)))) {
      issues.push({ path: "/message/tags", code: "invalid_schema" });
    }
  }
  if (!object(request.policy) || request.policy.mode !== "single") {
    issues.push({ path: "/policy/mode", code: "unsupported_policy" });
  }
  return issues;
}

export function assertValidRequest(request) {
  const issues = validateRequest(request);
  if (issues.length > 0) {
    const error = new UniPushError("invalid_schema", "Send request is invalid", 20);
    error.issues = issues;
    throw error;
  }
  return request;
}

export function resolveRoute(config, destination) {
  let channelName;
  if (destination.kind === "channel") {
    channelName = destination.name;
  } else {
    const target = config.targets[destination.name];
    if (!target) throw new UniPushError("destination_not_found", "Destination does not exist", 22);
    channelName = target.channels[0];
  }
  const channel = config.channels[channelName];
  if (!channel) throw new UniPushError("destination_not_found", "Channel does not exist", 22);
  const connection = config.connections[channel.connection];
  if (!connection) throw new UniPushError("configuration_invalid", "Channel connection does not exist", 21);
  return { channelName, channel, connection };
}

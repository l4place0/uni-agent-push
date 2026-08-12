import { createHash } from "node:crypto";
import { UniPushError } from "../errors.js";

const tokenCache = new Map();

function cacheKey(appId, clientSecret) {
  const secretFingerprint = createHash("sha256").update(clientSecret).digest("hex");
  return `${appId}:${secretFingerprint}`;
}

async function jsonCall(endpoint, { body, authorization, fetchImpl, timeoutMs = 8000 }) {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json;charset=utf-8",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (text.length > 65536) return { kind: "malformed", status: response.status };
    let payload;
    try { payload = JSON.parse(text); } catch { return { kind: "malformed", status: response.status }; }
    return { kind: "response", status: response.status, payload };
  } catch (error) {
    return { kind: error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "transport" };
  }
}

export async function getQQAccessToken({ appId, clientSecret, fetchImpl = fetch, now = Date.now }) {
  const key = cacheKey(appId, clientSecret);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - 60000 > now()) return { status: "accepted", token: cached.token };
  const result = await jsonCall("https://api.bot.qq.com/app/getAppAccessToken", {
    body: { appId, clientSecret }, fetchImpl,
  });
  if (result.kind !== "response") return { status: "rejected", reason: result.kind === "malformed" ? "malformed_response" : "token_transport_failure" };
  const seconds = Number(result.payload?.expires_in);
  if (result.status < 200 || result.status >= 300 || typeof result.payload?.access_token !== "string" || !result.payload.access_token || !Number.isInteger(seconds) || seconds <= 0) {
    return { status: "rejected", reason: "authentication_rejected" };
  }
  tokenCache.set(key, { token: result.payload.access_token, expiresAt: now() + seconds * 1000 });
  return { status: "accepted", token: result.payload.access_token };
}

export function prepareQQBot({ channel, message }) {
  const transformations = ["title_prefixed_to_body"];
  let content = message.format === "markdown" ? `## ${message.title}\n\n${message.body}` : `${message.title}\n\n${message.body}`;
  if (message.url) { content += `\n\n${message.url}`; transformations.push("url_appended_to_body"); }
  if (message.summary) transformations.push("summary_omitted");
  if (message.tags?.length) transformations.push("tags_omitted");
  if (content.length > 4096) throw new UniPushError("unsupported_content", "QQ Bot message is too long", 20);
  const target = channel.target;
  const segment = target.type === "group" ? "groups" : "users";
  const endpoint = `https://api.bot.qq.com/v2/${segment}/${encodeURIComponent(target.openid)}/messages`;
  const body = message.format === "markdown"
    ? { msg_type: 2, markdown: { content } }
    : { msg_type: 0, content };
  return { endpoint, body, transformations };
}

function qqReason(status, payload) {
  const code = Number(payload?.err_code);
  if (status === 401 || status === 403) return "authentication_rejected";
  if (status === 429 || code === 40034100 || code === 1100100) return "rate_limited";
  if ([40034101, 40054003, 1100104, 1100301].includes(code)) return "invalid_target";
  if ([40034006, 40054007, 40054010, 1100101].includes(code)) return "unsupported_content";
  return "provider_rejected";
}

export async function sendQQBot({ connection, clientSecret, prepared, fetchImpl = fetch }) {
  const access = await getQQAccessToken({ appId: connection.app_id, clientSecret, fetchImpl });
  if (access.status !== "accepted") return { status: "rejected", reason: access.reason, transformations: prepared.transformations };
  const result = await jsonCall(prepared.endpoint, {
    body: prepared.body,
    authorization: `QQBot ${access.token}`,
    fetchImpl,
  });
  if (result.kind === "timeout") return { status: "uncertain", reason: "timeout_after_send", transformations: prepared.transformations };
  if (result.kind === "transport") return { status: "uncertain", reason: "transport_ambiguous", transformations: prepared.transformations };
  if (result.kind === "malformed") return { status: "uncertain", reason: "malformed_response", transformations: prepared.transformations };
  if (result.status >= 200 && result.status < 300 && typeof result.payload?.id === "string" && result.payload.id) {
    return { status: "accepted", reason: "provider_accepted", transformations: prepared.transformations };
  }
  return { status: "rejected", reason: qqReason(result.status, result.payload), transformations: prepared.transformations };
}

export async function diagnoseQQBot({ connection, clientSecret, fetchImpl = fetch }) {
  const access = await getQQAccessToken({ appId: connection.app_id, clientSecret, fetchImpl });
  return access.status === "accepted" ? { status: "passed", reason: "ok" } : { status: "failed", reason: access.reason };
}

export function clearQQTokenCache() { tokenCache.clear(); }

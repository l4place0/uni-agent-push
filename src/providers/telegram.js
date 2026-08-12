import { UniPushError } from "../errors.js";

const TOKEN = /^[0-9]+:[A-Za-z0-9_-]{20,}$/;

export function validateTelegramToken(token) {
  if (!TOKEN.test(token)) throw new UniPushError("configuration_invalid", "Invalid Telegram Bot Token", 21);
  return token;
}

export function prepareTelegram({ token, channel, message }) {
  validateTelegramToken(token);
  const transformations = ["title_prefixed_to_body"];
  let text = `${message.title}\n\n${message.body}`;
  if (message.format === "markdown") transformations.push("markdown_rendered_as_plain");
  if (message.url) {
    text += `\n\n${message.url}`;
    transformations.push("url_appended_to_body");
  }
  if (message.summary) transformations.push("summary_omitted");
  if (message.tags?.length) transformations.push("tags_omitted");
  if (text.length > 4096) throw new UniPushError("unsupported_content", "Telegram message is too long", 20);
  const body = { chat_id: channel.chat_id, text };
  if (channel.message_thread_id) body.message_thread_id = channel.message_thread_id;
  if (channel.disable_link_preview) body.link_preview_options = { is_disabled: true };
  if (channel.silent) body.disable_notification = true;
  if (channel.protect_content) body.protect_content = true;
  return { endpoint: `https://api.telegram.org/bot${token}/sendMessage`, body, transformations };
}

async function telegramCall(endpoint, body, fetchImpl, timeoutMs = 8000) {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json;charset=utf-8" },
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

export async function sendPreparedTelegram(prepared, { fetchImpl = fetch } = {}) {
  const result = await telegramCall(prepared.endpoint, prepared.body, fetchImpl);
  if (result.kind === "timeout") return { status: "uncertain", reason: "timeout_after_send", transformations: prepared.transformations };
  if (result.kind === "transport") return { status: "uncertain", reason: "transport_ambiguous", transformations: prepared.transformations };
  if (result.kind === "malformed") return { status: "uncertain", reason: "malformed_response", transformations: prepared.transformations };
  const { status, payload } = result;
  if (status >= 200 && status < 300 && payload?.ok === true && Number.isInteger(payload.result?.message_id)) {
    return { status: "accepted", reason: "provider_accepted", transformations: prepared.transformations };
  }
  const description = typeof payload?.description === "string" ? payload.description.toLowerCase() : "";
  const targetRejected = payload?.parameters?.migrate_to_chat_id !== undefined
    || /chat not found|message thread not found|bot is not a member|not enough rights|have no rights|kicked/.test(description);
  const contentRejected = /message text is empty|message is too long|can't parse entities|entity/.test(description);
  const reason = status === 401 ? "authentication_rejected"
    : status === 403 ? "invalid_target"
      : status === 429 || payload?.error_code === 429 ? "rate_limited"
        : status === 400 && targetRejected ? "invalid_target"
          : status === 400 && contentRejected ? "unsupported_content"
          : "provider_rejected";
  return { status: "rejected", reason, transformations: prepared.transformations };
}

export async function diagnoseTelegram({ token, channel, fetchImpl = fetch }) {
  validateTelegramToken(token);
  const base = `https://api.telegram.org/bot${token}`;
  const me = await telegramCall(`${base}/getMe`, {}, fetchImpl);
  if (me.kind !== "response" || me.status < 200 || me.status >= 300 || me.payload?.ok !== true || me.payload.result?.is_bot !== true) {
    return { status: "failed", reason: "authentication_rejected" };
  }
  const chat = await telegramCall(`${base}/getChat`, { chat_id: channel.chat_id }, fetchImpl);
  if (chat.kind !== "response" || chat.status < 200 || chat.status >= 300 || chat.payload?.ok !== true) {
    return { status: "failed", reason: "invalid_target" };
  }
  return { status: "passed", reason: "ok" };
}

function updateChat(update) {
  return update?.message?.chat
    ?? update?.edited_message?.chat
    ?? update?.channel_post?.chat
    ?? update?.edited_channel_post?.chat
    ?? update?.my_chat_member?.chat
    ?? update?.chat_member?.chat
    ?? update?.chat_join_request?.chat;
}

export async function discoverTelegramChats({ token, fetchImpl = fetch }) {
  validateTelegramToken(token);
  const base = `https://api.telegram.org/bot${token}`;
  const webhook = await telegramCall(`${base}/getWebhookInfo`, {}, fetchImpl);
  if (webhook.kind !== "response" || webhook.status < 200 || webhook.status >= 300 || webhook.payload?.ok !== true) {
    return { status: "failed", reason: "discovery_unavailable", candidates: [] };
  }
  if (typeof webhook.payload.result?.url === "string" && webhook.payload.result.url) {
    return { status: "blocked", reason: "webhook_active", candidates: [] };
  }
  const updates = await telegramCall(`${base}/getUpdates`, { timeout: 0, limit: 100 }, fetchImpl);
  if (updates.kind !== "response" || updates.status < 200 || updates.status >= 300 || updates.payload?.ok !== true || !Array.isArray(updates.payload.result)) {
    return { status: "failed", reason: "discovery_unavailable", candidates: [] };
  }
  const unique = new Map();
  for (const update of updates.payload.result) {
    const chat = updateChat(update);
    if (Number.isSafeInteger(chat?.id) && ["private", "group", "supergroup", "channel"].includes(chat?.type)) {
      unique.set(String(chat.id), { chat_id: String(chat.id), type: chat.type });
    }
  }
  const candidates = [];
  for (const candidate of unique.values()) {
    const checked = await telegramCall(`${base}/getChat`, { chat_id: candidate.chat_id }, fetchImpl);
    if (checked.kind === "response" && checked.status >= 200 && checked.status < 300 && checked.payload?.ok === true) {
      candidates.push(candidate);
    }
  }
  return { status: "passed", reason: candidates.length ? "candidates_found" : "no_candidates", candidates };
}

import { UniPushError } from "../errors.js";

export function classifySendKey(sendKey) {
  if (/^SCT[^/\s]+$/.test(sendKey)) {
    return {
      edition: "sct",
      endpoint: `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`,
    };
  }
  const sc3 = /^sctp([0-9]+)t[^/\s]+$/.exec(sendKey);
  if (sc3) {
    return {
      edition: "sc3",
      endpoint: `https://${sc3[1]}.push.ft07.com/send/${encodeURIComponent(sendKey)}.send`,
    };
  }
  throw new UniPushError("configuration_invalid", "Unsupported ServerChan SendKey", 21);
}

export function prepareServerChan({ sendKey, channel, message }) {
  const { edition, endpoint } = classifySendKey(sendKey);
  if (edition === "sc3" && (channel.delivery_channels || channel.hide_caller_ip)) {
    throw new UniPushError("configuration_invalid", "Configured ServerChan option is incompatible with SC3", 21);
  }

  const transformations = [];
  let description = message.body;
  if (message.url) {
    description += `\n\n${message.url}`;
    transformations.push("url_appended_to_body");
  }

  const body = { title: message.title, desp: description };
  if (message.summary) body.short = message.summary;
  if (message.tags?.length) {
    if (edition === "sc3") body.tags = message.tags.join("|");
    else transformations.push("tags_omitted");
  }
  if (channel.delivery_channels) body.channel = channel.delivery_channels.join("|");
  if (channel.hide_caller_ip) body.noip = 1;

  return { endpoint, edition, body, transformations };
}

function result(status, reason, transformations) {
  return { status, reason, transformations };
}

export async function sendPreparedServerChan(prepared, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  try {
    const response = await fetchImpl(prepared.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json;charset=utf-8" },
      body: JSON.stringify(prepared.body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (text.length > 65536) return result("uncertain", "malformed_response", prepared.transformations);
    if (response.status === 429) return result("rejected", "rate_limited", prepared.transformations);
    if (!response.ok) return result("rejected", "transport_rejected", prepared.transformations);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return result("uncertain", "malformed_response", prepared.transformations);
    }
    if (payload && Number.isInteger(payload.code) && payload.code === 0) {
      return result("accepted", "provider_accepted", prepared.transformations);
    }
    return result("rejected", "provider_rejected", prepared.transformations);
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      return result("uncertain", "timeout_after_send", prepared.transformations);
    }
    return result("uncertain", "transport_ambiguous", prepared.transformations);
  }
}

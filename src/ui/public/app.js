const token = new URLSearchParams(location.hash.slice(1)).get("session") ?? "";
history.replaceState(null, "", location.pathname);

const form = document.querySelector("#config-form");
const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
let session = { mode: "config", config_path: "" };

function value(id) {
  return document.querySelector(`#${id}`).value.trim();
}

function buildConfig() {
  const provider = value("provider");
  const connection = value("connection");
  const channel = value("channel");
  const target = value("target");
  const credentialSource = value("credential-source");
  const reference = credentialSource === "store" ? `store:${connection}` : `env:${value("environment")}`;
  let connectionConfig;
  let channelConfig = { provider, connection };
  if (provider === "serverchan") {
    connectionConfig = { provider, send_key: reference };
    const delivery = value("delivery-channels").split(",").map((item) => item.trim()).filter(Boolean);
    if (delivery.length) channelConfig.delivery_channels = delivery;
    if (document.querySelector("#hide-ip").checked) channelConfig.hide_caller_ip = true;
  } else if (provider === "telegram") {
    connectionConfig = { provider, token: reference };
    channelConfig.chat_id = value("telegram-chat-id");
    const threadId = Number(value("telegram-thread-id"));
    if (threadId) channelConfig.message_thread_id = threadId;
    if (document.querySelector("#telegram-disable-preview").checked) channelConfig.disable_link_preview = true;
    if (document.querySelector("#telegram-silent").checked) channelConfig.silent = true;
    if (document.querySelector("#telegram-protect").checked) channelConfig.protect_content = true;
  } else {
    connectionConfig = { provider, app_id: value("qq-app-id"), client_secret: reference };
    channelConfig.target = { type: value("qq-target-type"), openid: value("qq-openid") };
  }
  return {
    version: 1,
    connections: { [connection]: connectionConfig },
    channels: { [channel]: channelConfig },
    targets: { [target]: { channels: [channel], policy: "single" } },
  };
}

function render() {
  preview.textContent = JSON.stringify(buildConfig(), null, 2);
}

function showStep(step) {
  for (const element of document.querySelectorAll("[data-step]")) element.hidden = Number(element.dataset.step) !== step;
  for (const indicator of document.querySelectorAll("[data-step-indicator]")) {
    const number = Number(indicator.dataset.stepIndicator);
    indicator.classList.toggle("active", number === step);
    indicator.classList.toggle("done", number < step);
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch (cause) {
    throw new Error("network_unavailable", { cause });
  }
  let result;
  try {
    result = await response.json();
  } catch (cause) {
    throw new Error("invalid_server_response", { cause });
  }
  if (!response.ok) throw new Error(result.error ?? "request_failed");
  return result;
}

function failureText(error, fallback) {
  if (error.message === "network_unavailable") return "网络连接失败：本地配置服务不可用，请重新打开配置页面。";
  if (["unauthorized", "request_forbidden"].includes(error.message)) return "会话已失效，请重新打开配置页面。";
  if (error.message === "invalid_server_response") return "本地配置服务响应异常，请重新启动向导。";
  return fallback;
}

function deliveryReasonText(reason) {
  const labels = {
    authentication_rejected: "凭据被平台拒绝",
    invalid_target: "目标不可用；请确认 Chat ID、机器人已加入会话且有发言权限",
    rate_limited: "平台限流，请稍后再试",
    unsupported_content: "消息内容不受支持",
    provider_rejected: "平台拒绝了请求",
  };
  return labels[reason] ?? reason;
}

function updateCredentialFields() {
  const stored = value("credential-source") === "store";
  document.querySelector("#stored-credential-fields").hidden = !stored;
  document.querySelector("#environment-fields").hidden = stored;
  document.querySelector("#environment").required = !stored;
}

const providerDefaults = {
  serverchan: { connection: "serverchan-main", channel: "serverchan.owner", environment: "SERVERCHAN_SEND_KEY", label: "ServerChan SendKey", placeholder: "SCT… 或 sctp…" },
  telegram: { connection: "telegram-main", channel: "telegram.owner", environment: "TELEGRAM_BOT_TOKEN", label: "Telegram Bot Token", placeholder: "123456789:ABC…" },
  qqbot: { connection: "qq-main", channel: "qq.owner", environment: "QQBOT_CLIENT_SECRET", label: "QQ Bot AppSecret", placeholder: "开放平台 AppSecret" },
};

function updateProviderFields({ resetNames = false } = {}) {
  const provider = value("provider");
  const defaults = providerDefaults[provider];
  document.querySelector("#serverchan-channel-fields").hidden = provider !== "serverchan";
  document.querySelector("#telegram-channel-fields").hidden = provider !== "telegram";
  document.querySelector("#qq-channel-fields").hidden = provider !== "qqbot";
  document.querySelector("#qq-connection-fields").hidden = provider !== "qqbot";
  document.querySelector("#credential-label").textContent = defaults.label;
  document.querySelector("#send-key").placeholder = defaults.placeholder;
  if (resetNames) {
    document.querySelector("#connection").value = defaults.connection;
    document.querySelector("#channel").value = defaults.channel;
    document.querySelector("#environment").value = defaults.environment;
    document.querySelector("#credential-help").textContent = `尚未保存凭据。请输入${defaults.label}。`;
  }
}

function populate(config, credentials = {}) {
  const [connectionName, connection] = Object.entries(config.connections)[0];
  const [channelName, channel] = Object.entries(config.channels)[0];
  const [targetName] = Object.entries(config.targets)[0];
  document.querySelector("#connection").value = connectionName;
  document.querySelector("#provider").value = connection.provider;
  const reference = connection.send_key ?? connection.token ?? connection.client_secret;
  const stored = reference.startsWith("store:");
  document.querySelector("#credential-source").value = stored ? "store" : "env";
  if (!stored) document.querySelector("#environment").value = reference.replace(/^env:/, "");
  const credentialState = credentials[connectionName];
  document.querySelector("#credential-help").textContent = credentialState?.configured
    ? "凭据已保存。留空表示保持不变；输入新值将替换。"
    : `尚未保存凭据。请输入${providerDefaults[connection.provider].label}。`;
  updateProviderFields();
  updateCredentialFields();
  document.querySelector("#qq-app-id").value = connection.app_id ?? "";
  document.querySelector("#channel").value = channelName;
  document.querySelector("#delivery-channels").value = channel.delivery_channels?.join(", ") ?? "";
  document.querySelector("#hide-ip").checked = channel.hide_caller_ip === true;
  document.querySelector("#telegram-chat-id").value = channel.chat_id ?? "";
  document.querySelector("#telegram-thread-id").value = channel.message_thread_id ?? "";
  document.querySelector("#telegram-disable-preview").checked = channel.disable_link_preview === true;
  document.querySelector("#telegram-silent").checked = channel.silent === true;
  document.querySelector("#telegram-protect").checked = channel.protect_content === true;
  document.querySelector("#qq-target-type").value = channel.target?.type ?? "user";
  document.querySelector("#qq-openid").value = channel.target?.openid ?? "";
  document.querySelector("#target").value = targetName;
  render();
}

async function validate() {
  const result = await api("/api/validate", { method: "POST", body: JSON.stringify(buildConfig()) });
  status.textContent = result.valid
    ? "配置有效"
    : `配置无效：${result.issues.map((item) => item.path || "/").join("、")}`;
  return result.valid;
}

async function save() {
  if (!(await validate())) return false;
  const config = buildConfig();
  const credential = value("credential-source") === "store" && value("send-key")
    ? { id: value("connection"), value: value("send-key") }
    : undefined;
  await api("/api/save", { method: "POST", body: JSON.stringify({ config, credential }) });
  document.querySelector("#send-key").value = "";
  document.querySelector("#credential-help").textContent = "凭据已保存。留空表示保持不变；输入新值将替换。";
  status.textContent = "已保存";
  return true;
}

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function complete() {
  const commands = [
    `export UNI_PUSH_CONFIG=${shellQuote(session.config_path)}`,
    "uni-push doctor --json",
    "uni-push targets --json",
  ];
  if (value("credential-source") === "env") commands.splice(1, 0, `# 确保 ${value("environment")} 已在当前环境中设置`);
  document.querySelector("#next-commands").textContent = commands.join("\n");
  showStep(3);
}

form.addEventListener("input", render);
document.querySelector("#credential-source").addEventListener("change", () => { updateCredentialFields(); render(); });
document.querySelector("#provider").addEventListener("change", () => { updateProviderFields({ resetNames: true }); render(); });
document.querySelector("#discover-telegram").addEventListener("click", async () => {
  const output = document.querySelector("#telegram-discovery-result");
  output.textContent = "正在只读查找…";
  try {
    const credential = value("credential-source") === "store" && value("send-key") ? value("send-key") : undefined;
    const result = await api("/api/discover/telegram", {
      method: "POST",
      body: JSON.stringify({ config: buildConfig(), credential }),
    });
    if (result.reason === "webhook_active") {
      output.textContent = "该 Bot 已启用 Webhook；请从现有 Webhook 入站事件提取 chat.id。";
    } else if (!result.candidates.length) {
      output.textContent = "没有候选目标。请先向 Bot 发送 /start，或在目标群中 @Bot 后重试。";
    } else if (result.candidates.length === 1) {
      document.querySelector("#telegram-chat-id").value = result.candidates[0].chat_id;
      render();
      output.textContent = `已填入候选 ${result.candidates[0].chat_id}（${result.candidates[0].type}）。`;
    } else {
      output.textContent = `发现多个候选，请复制目标 ID：${result.candidates.map((item) => `${item.chat_id}（${item.type}）`).join("、")}`;
    }
  } catch (error) {
    output.textContent = error.message === "configuration_invalid"
      ? "Bot Token 格式不正确。"
      : failureText(error, "查找失败，请确认 Token 后重试。");
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (await save()) showStep(2);
  } catch (error) {
    status.textContent = error.message === "credential_required"
      ? "请填写平台凭据"
      : error.message === "configuration_invalid"
        ? "凭据格式不正确"
        : failureText(error, "保存失败");
  }
});
document.querySelector("#validate").addEventListener("click", () => validate().catch((error) => {
  status.textContent = failureText(error, "校验请求失败");
}));
document.querySelector("#start").addEventListener("click", () => showStep(1));
document.querySelector("#back-start").addEventListener("click", () => showStep(session.mode === "onboard" ? 0 : 1));
document.querySelector("#back-config").addEventListener("click", () => showStep(1));
document.querySelector("#run-check").addEventListener("click", async () => {
  const output = document.querySelector("#check-result");
  output.textContent = "正在检查…";
  try {
    const result = await api("/api/check", { method: "POST", body: JSON.stringify(buildConfig()) });
    output.textContent = result.status === "passed"
      ? "检查通过：配置、凭据和目标均可用。"
      : "检查未通过：请返回配置，确认已保存有效的平台凭据和目标。";
    output.dataset.status = result.status;
    document.querySelector("#finish").disabled = result.status !== "passed";
  } catch (error) { output.textContent = failureText(error, "检查请求失败"); }
});

const confirmation = document.querySelector("#test-confirm");
const sendTest = document.querySelector("#send-test");
confirmation.addEventListener("change", () => { sendTest.disabled = !confirmation.checked; });
sendTest.addEventListener("click", async () => {
  const output = document.querySelector("#test-result");
  sendTest.disabled = true;
  output.textContent = "正在发送…";
  try {
    const result = await api("/api/test", {
      method: "POST",
      body: JSON.stringify({ config: buildConfig(), confirmed: confirmation.checked }),
    });
    output.textContent = result.status === "accepted"
      ? "平台已接受测试通知。"
      : `测试未发送：${deliveryReasonText(result.reason)}。`;
    output.dataset.status = result.status;
  } catch (error) {
    output.textContent = error.message === "explicit_confirmation_required"
      ? "请先明确确认。"
      : failureText(error, "测试发送失败");
    sendTest.disabled = !confirmation.checked;
  }
});
document.querySelector("#finish").addEventListener("click", complete);
document.querySelector("#shutdown").addEventListener("click", async () => {
  document.querySelector("#shutdown").disabled = true;
  await api("/api/shutdown", { method: "POST", body: "{}" }).catch(() => {});
});

Promise.all([api("/api/session"), api("/api/config")])
  .then(([loadedSession, { config, credentials }]) => {
    session = loadedSession;
    populate(config, credentials);
    document.querySelector("#config-path").textContent = session.config_path;
    if (session.mode === "onboard") {
      document.querySelector("#page-title").textContent = "欢迎使用 Uni Push";
      document.querySelector("#page-description").textContent = "四步完成推送平台配置、检查和可选测试。";
      showStep(0);
    } else {
      for (const element of document.querySelectorAll(".onboard-only")) element.hidden = true;
      showStep(1);
    }
    status.textContent = "已加载";
  })
  .catch((error) => { render(); status.textContent = failureText(error, "会话无效，请重新打开配置页面。"); });

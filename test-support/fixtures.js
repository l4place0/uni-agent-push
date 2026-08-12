export function config() {
  return {
    version: 1,
    connections: {
      "serverchan-main": { provider: "serverchan", send_key: "env:SERVERCHAN_SEND_KEY" },
    },
    channels: {
      "serverchan.owner": { provider: "serverchan", connection: "serverchan-main" },
    },
    targets: {
      owner: { channels: ["serverchan.owner"], policy: "single" },
    },
  };
}

export function request(overrides = {}) {
  const { message: messageOverrides = {}, ...requestOverrides } = overrides;
  return {
    schema_version: 1,
    notification_id: "test-2026-08-11.1",
    destination: { kind: "target", name: "owner" },
    message: {
      title: "Test complete",
      body: "The deterministic test finished.",
      format: "plain",
      priority: "normal",
      ...messageOverrides,
    },
    policy: { mode: "single" },
    ...requestOverrides,
  };
}

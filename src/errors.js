export class UniPushError extends Error {
  constructor(code, message, exitCode = 24) {
    super(message);
    this.name = "UniPushError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function publicError(error, notificationId) {
  const code = error instanceof UniPushError ? error.code : "internal_error";
  const result = { schema_version: 1, status: "error", error: code };
  if (notificationId) result.notification_id = notificationId;
  return result;
}

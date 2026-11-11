export class LogsError extends Error {
  constructor(code, status, message) { super(message); this.name = 'LogsError'; this.code = code; this.status = status; }
}

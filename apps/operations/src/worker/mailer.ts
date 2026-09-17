import type { Env } from "./types";

/** Only these transport bindings/settings are consulted by notification mail. */
export type NotificationMailEnvironment = Partial<Pick<Env,
  "SMTP_NOTIFICATIONS_ENABLED" | "SMTP_HOST" | "SMTP_USERNAME" | "SMTP_PASSWORD"
  | "SMTP_FROM" | "NOTIFICATION_EMAIL" | "NOTIFICATION_FROM">>;

export interface OutboundMail {
  to: string;
  fromName: string;
  subject: string;
  text: string;
  html: string;
  /** Stable durable-outbox identifier used as SMTP Message-ID on retries. */
  messageIdKey?: string;
}

interface SmtpSettings {
  host: string;
  username: string;
  password: string;
  from: string;
}

const SMTP_PORT = 465;
const SMTP_OPERATION_TIMEOUT_MS = 20_000;
const SMTP_TOTAL_TIMEOUT_MS = 45_000;
const SMTP_MAX_RESPONSE_BYTES = 64 * 1024;
const SMTP_MAX_RESPONSE_LINES = 128;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The provider may have accepted the message; callers must not blindly retry. */
export class NotificationMailDeliveryUncertain extends Error {
  constructor() { super("notification_mail_delivery_uncertain"); this.name = "NotificationMailDeliveryUncertain"; }
}

class SmtpRejectedError extends Error {
  constructor(code: number | undefined) { super(`SMTP server rejected the request (${code || "unknown"})`); }
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Lines(value: string): string {
  const encoded = base64Utf8(value);
  return encoded.match(/.{1,76}/g)?.join("\r\n") || "";
}

function encodedHeader(value: string): string {
  const clean = cleanHeader(value);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64Utf8(clean)}?=`;
}

function requireEmail(value: string | undefined, field: string): string {
  const email = cleanHeader(value || "").toLowerCase();
  if (!EMAIL.test(email)) throw new Error(`${field} is not configured with a valid email address`);
  return email;
}

export function smtpNotificationsEnabled(env: NotificationMailEnvironment): boolean {
  return env.SMTP_NOTIFICATIONS_ENABLED === "true";
}

function smtpSettings(env: NotificationMailEnvironment): SmtpSettings {
  const host = (env.SMTP_HOST || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || !host.includes(".")) throw new Error("SMTP_HOST is not configured with a valid hostname");
  const username = requireEmail(env.SMTP_USERNAME, "SMTP_USERNAME");
  const password = env.SMTP_PASSWORD || "";
  if (!password.trim()) throw new Error("SMTP_PASSWORD is not configured");
  return { host, username, password, from: requireEmail(env.SMTP_FROM || env.SMTP_USERNAME, "SMTP_FROM") };
}

export function buildSmtpMessage(mail: OutboundMail, from: string): string {
  const to = requireEmail(mail.to, "notification recipient");
  const sender = requireEmail(from, "SMTP_FROM");
  const boundary = `=_ltds_${crypto.randomUUID().replaceAll("-", "")}`;
  const messageIdKey = cleanHeader(mail.messageIdKey || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 160);
  const messageId = `<${messageIdKey}@${sender.split("@")[1]}>`;
  return [
    `From: ${encodedHeader(mail.fromName)} <${sender}>`,
    `To: <${to}>`,
    `Subject: ${encodedHeader(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(mail.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function sendWithSmtp(settings: SmtpSettings, mail: OutboundMail): Promise<void> {
  const deadline = Date.now() + SMTP_TOTAL_TIMEOUT_MS;
  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: settings.host, port: SMTP_PORT }, { secureTransport: "on", allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let responseBytes = 0;
  let responseLines = 0;

  const close = (): void => {
    try { void socket.close().catch(() => { /* Best-effort connection cleanup. */ }); }
    catch { /* Best-effort connection cleanup. */ }
  };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      close();
      throw new Error("SMTP connection timed out");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("SMTP connection timed out"));
          // Settle the timeout first. Closing the socket also resolves a
          // pending read as EOF, which must not win the timeout race.
          close();
        }, Math.min(SMTP_OPERATION_TIMEOUT_MS, remaining));
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const response = async (allowed: number[]): Promise<void> => {
    let code: number | undefined;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        const next = await bounded(() => reader.read());
        if (next.done) throw new Error("SMTP server closed the connection unexpectedly");
        responseBytes += next.value.byteLength;
        if (responseBytes > SMTP_MAX_RESPONSE_BYTES) throw new Error("SMTP response exceeded the size limit");
        buffered += decoder.decode(next.value, { stream: true });
        continue;
      }
      responseLines++;
      if (responseLines > SMTP_MAX_RESPONSE_LINES) throw new Error("SMTP response exceeded the line limit");
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) throw new Error("SMTP server returned an invalid response");
      const lineCode = Number(match[1]);
      if (code !== undefined && lineCode !== code) throw new Error("SMTP server returned an invalid response");
      code = lineCode;
      if (match[2] === " ") break;
    }
    if (!code || !allowed.includes(code)) {
      if (code && code >= 400 && code <= 599) throw new SmtpRejectedError(code);
      throw new Error("SMTP server returned an invalid response");
    }
  };
  const command = async (line: string, allowed: number[]): Promise<void> => {
    await bounded(() => writer.write(encoder.encode(`${line}\r\n`)));
    await response(allowed);
  };

  try {
    await response([220]);
    await command("EHLO ltds-ops", [250]);
    await command("AUTH LOGIN", [334]);
    await command(base64Utf8(settings.username), [334]);
    await command(base64Utf8(settings.password), [235]);
    await command(`MAIL FROM:<${settings.from}>`, [250]);
    await command(`RCPT TO:<${requireEmail(mail.to, "notification recipient")}>`, [250, 251]);
    await command("DATA", [354]);
    const payload = encoder.encode(`${buildSmtpMessage(mail, settings.from).replace(/(^|\r\n)\./g, "$1..")}\r\n.\r\n`);
    try {
      // Once writing starts, transport failure or missing acknowledgement has
      // an ambiguous delivery outcome. A negative SMTP reply is definitive.
      await bounded(() => writer.write(payload));
      await response([250]);
    } catch (error) {
      if (error instanceof SmtpRejectedError) throw error;
      throw new NotificationMailDeliveryUncertain();
    }
  } finally {
    // DATA's final 250 means the server accepted the message. QUIT is only a
    // courtesy exchange: a broken QUIT or socket teardown must not turn an
    // accepted message into a retry. Close without awaiting another response.
    close();
    try { writer.releaseLock(); } catch { /* The socket may already be closed. */ }
    try { reader.releaseLock(); } catch { /* The socket may already be closed. */ }
  }
}

/** Non-sending preflight. The adapter must call this before any claim. */
export function validateNotificationMailTransport(env: NotificationMailEnvironment): void {
  if (smtpNotificationsEnabled(env)) {
    smtpSettings(env);
    return;
  }
  if (!env.NOTIFICATION_EMAIL || typeof env.NOTIFICATION_EMAIL.send !== "function")
    throw new Error("Notification email transport is not configured");
  requireEmail(env.NOTIFICATION_FROM, "NOTIFICATION_FROM");
}

/** Sends through SMTP only when explicitly enabled; otherwise retains the Cloudflare binding path. */
export async function sendNotificationMail(env: NotificationMailEnvironment, mail: OutboundMail): Promise<void> {
  if (smtpNotificationsEnabled(env)) {
    await sendWithSmtp(smtpSettings(env), mail);
    return;
  }
  if (!env.NOTIFICATION_EMAIL || !env.NOTIFICATION_FROM) throw new Error("Notification email transport is not configured");
  const outgoing = { to: requireEmail(mail.to, "notification recipient"), from: { email: requireEmail(env.NOTIFICATION_FROM, "NOTIFICATION_FROM"), name: cleanHeader(mail.fromName) }, subject: cleanHeader(mail.subject), text: mail.text, html: mail.html };
  try { await env.NOTIFICATION_EMAIL.send(outgoing); }
  catch { throw new NotificationMailDeliveryUncertain(); }
}

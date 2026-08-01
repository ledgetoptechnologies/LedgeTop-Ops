import type { Env } from "./types";

export interface OutboundMail {
  to: string;
  fromName: string;
  subject: string;
  text: string;
  html: string;
}

interface SmtpSettings {
  host: string;
  username: string;
  password: string;
  from: string;
}

const SMTP_PORT = 465;
const SMTP_TIMEOUT_MS = 20_000;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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

export function smtpNotificationsEnabled(env: Env): boolean {
  return env.SMTP_NOTIFICATIONS_ENABLED === "true";
}

function smtpSettings(env: Env): SmtpSettings {
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
  const messageId = `<${crypto.randomUUID()}@${sender.split("@")[1]}>`;
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

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SMTP connection timed out")), SMTP_TIMEOUT_MS); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sendWithSmtp(settings: SmtpSettings, mail: OutboundMail): Promise<void> {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: settings.host, port: SMTP_PORT }, { secureTransport: "on", allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";

  const response = async (allowed: number[]): Promise<void> => {
    let code: number | undefined;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        const next = await withTimeout(reader.read());
        if (next.done) throw new Error("SMTP server closed the connection unexpectedly");
        buffered += decoder.decode(next.value, { stream: true });
        continue;
      }
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) throw new Error("SMTP server returned an invalid response");
      code = Number(match[1]);
      if (match[2] === " ") break;
    }
    if (!code || !allowed.includes(code)) throw new Error(`SMTP server rejected the request (${code || "unknown"})`);
  };
  const command = async (line: string, allowed: number[]): Promise<void> => {
    await withTimeout(writer.write(encoder.encode(`${line}\r\n`)));
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
    await withTimeout(writer.write(encoder.encode(`${buildSmtpMessage(mail, settings.from).replace(/(^|\r\n)\./g, "$1..")}\r\n.\r\n`)));
    await response([250]);
    await command("QUIT", [221]);
  } finally {
    // `socket.close()` tears down both streams. Awaiting stream closure here can
    // linger after SMTP has already accepted DATA, which would delay the durable
    // outbox acknowledgement and risk a duplicate retry.
    socket.close();
    writer.releaseLock();
    reader.releaseLock();
  }
}

/** Sends through SMTP only when explicitly enabled; otherwise retains the Cloudflare binding path. */
export async function sendNotificationMail(env: Env, mail: OutboundMail): Promise<void> {
  if (smtpNotificationsEnabled(env)) {
    await sendWithSmtp(smtpSettings(env), mail);
    return;
  }
  if (!env.NOTIFICATION_EMAIL || !env.NOTIFICATION_FROM) throw new Error("Notification email transport is not configured");
  await env.NOTIFICATION_EMAIL.send({ to: requireEmail(mail.to, "notification recipient"), from: { email: requireEmail(env.NOTIFICATION_FROM, "NOTIFICATION_FROM"), name: cleanHeader(mail.fromName) }, subject: cleanHeader(mail.subject), text: mail.text, html: mail.html });
}

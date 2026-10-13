import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const smtp = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("cloudflare:sockets", () => ({ connect: smtp.connect }));

import { NotificationMailDeliveryUncertain, notificationMailFailureCode, sendNotificationMail,
  validateNotificationMailTransport, type OutboundMail } from "../src/worker/mailer";

const mail: OutboundMail = {
  to: "recipient@example.test",
  fromName: "Operations",
  subject: "Notice",
  text: "Message",
  html: "<p>Message</p>",
  messageIdKey: "stable-notice-id",
};

const environment = {
  SMTP_NOTIFICATIONS_ENABLED: "true",
  SMTP_HOST: "smtp.example.test",
  SMTP_USERNAME: "sender@example.test",
  SMTP_PASSWORD: "synthetic-password",
  SMTP_FROM: "sender@example.test",
} as Env;

async function failure(operation: () => unknown | Promise<unknown>): Promise<unknown> {
  try { await operation(); throw new Error("expected operation to fail"); }
  catch (error) { return error; }
}

function scriptedSocket(options: { finalDataCode?: number; authCode?: number; closeThrows?: boolean;
  greeting?: string; replyDelayMs?: number; suppressFinalReply?: boolean; bodyWriteRejects?: boolean;
  finalReplyText?: string; readFailsBeforeGreeting?: boolean } = {}) {
  const writes: string[] = [];
  const replyTimers: Array<ReturnType<typeof setTimeout>> = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let step = 0;
  const replies = [250, 334, 334, options.authCode ?? 235, 250, 250, 354, options.finalDataCode ?? 250];
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (options.readFailsBeforeGreeting) controller.error(new Error("private read failure"));
      else controller.enqueue(new TextEncoder().encode(options.greeting ?? "220 Ready\r\n"));
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(value) {
      const line = new TextDecoder().decode(value);
      writes.push(line);
      if (line.startsWith("QUIT")) throw new Error("QUIT connection lost");
      if (options.bodyWriteRejects && line.includes("\r\n.\r\n")) throw new Error("Socket write failed");
      const code = replies[step++];
      if (code === undefined) throw new Error("Unexpected SMTP write");
      if (options.suppressFinalReply && step === replies.length) return;
      const answer = () => { if (!closed) controller.enqueue(new TextEncoder().encode(
        step === replies.length && options.finalReplyText ? options.finalReplyText : `${code} Synthetic response\r\n`)); };
      if (options.replyDelayMs) replyTimers.push(setTimeout(answer, options.replyDelayMs));
      else answer();
    },
  });
  const close = vi.fn(async () => {
    if (!closed) {
      closed = true;
      for (const timer of replyTimers) clearTimeout(timer);
      controller.close();
    }
    if (options.closeThrows) throw new Error("Socket teardown failed");
  });
  return { socket: { readable, writable, close }, writes, close };
}

beforeEach(() => smtp.connect.mockReset());
afterEach(() => vi.useRealTimers());

describe("SMTP acceptance boundary", () => {
  it("reports success after final DATA 250 without sending or waiting for QUIT", async () => {
    const scripted = scriptedSocket({ closeThrows: true });
    smtp.connect.mockReturnValue(scripted.socket);

    await expect(sendNotificationMail(environment, mail)).resolves.toBeUndefined();

    expect(scripted.writes).toHaveLength(8);
    expect(scripted.writes[7]).toContain("\r\n.\r\n");
    expect(scripted.writes.some(line => line.startsWith("QUIT"))).toBe(false);
    expect(scripted.close).toHaveBeenCalledOnce();
  });

  it("preserves final DATA rejection as a send failure", async () => {
    const scripted = scriptedSocket({ finalDataCode: 550, closeThrows: true });
    smtp.connect.mockReturnValue(scripted.socket);

    const error = await failure(() => sendNotificationMail(environment, mail));
    expect(error).toHaveProperty("message", "SMTP server rejected the request (550)");
    expect(notificationMailFailureCode(error)).toBe("mail-smtp-rejected");
    expect(scripted.close).toHaveBeenCalledOnce();
  });

  it("preserves an authentication failure before DATA", async () => {
    const scripted = scriptedSocket({ authCode: 535 });
    smtp.connect.mockReturnValue(scripted.socket);

    const error = await failure(() => sendNotificationMail(environment, mail));
    expect(error).toHaveProperty("message", "SMTP server rejected the request (535)");
    expect(notificationMailFailureCode(error)).toBe("mail-smtp-authentication-failed");
    expect(scripted.writes).toHaveLength(4);
  });

  it("bounds the entire SMTP session even when each individual response is timely", async () => {
    vi.useFakeTimers();
    const scripted = scriptedSocket({ replyDelayMs: 10_000 });
    smtp.connect.mockReturnValue(scripted.socket);

    const pending = sendNotificationMail(environment, mail);
    const settled = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await vi.advanceTimersByTimeAsync(46_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toHaveProperty("message", "SMTP connection timed out");
      expect(notificationMailFailureCode(result.error)).toBe("mail-transport-timeout");
    }
    expect(scripted.close).toHaveBeenCalled();
    expect(scripted.writes.some(line => line.includes("\r\n.\r\n"))).toBe(false);
  });

  it("rejects oversized and excessive-line server responses before DATA", async () => {
    for (const greeting of [
      `220-${"x".repeat(65_536)}\r\n`,
      `${"220-More\r\n".repeat(129)}220 Ready\r\n`,
    ]) {
      const scripted = scriptedSocket({ greeting });
      smtp.connect.mockReturnValue(scripted.socket);
      const error = await failure(() => sendNotificationMail(environment, mail));
      expect(error).toHaveProperty("message", expect.stringMatching(/response exceeded/));
      expect(notificationMailFailureCode(error)).toBe("mail-smtp-protocol-failed");
      expect(scripted.writes).toHaveLength(0);
      expect(scripted.close).toHaveBeenCalled();
    }
  });

  it("classifies missing final DATA acknowledgement and payload write failure as uncertain", async () => {
    vi.useFakeTimers();
    const silent = scriptedSocket({ suppressFinalReply: true });
    smtp.connect.mockReturnValue(silent.socket);
    const pending = sendNotificationMail(environment, mail);
    const settled = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    await vi.advanceTimersByTimeAsync(20_001);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(NotificationMailDeliveryUncertain);
    expect(silent.close).toHaveBeenCalled();

    vi.useRealTimers();
    const broken = scriptedSocket({ bodyWriteRejects: true });
    smtp.connect.mockReturnValue(broken.socket);
    await expect(sendNotificationMail(environment, mail)).rejects.toBeInstanceOf(NotificationMailDeliveryUncertain);
    expect(broken.close).toHaveBeenCalled();
  });

  it("does not mistake an unexpected final code or mixed multiline reply for definite rejection", async () => {
    for (const options of [
      { finalDataCode: 251 },
      { finalReplyText: "250-continued\r\n550 changed code\r\n" },
    ]) {
      const scripted = scriptedSocket(options);
      smtp.connect.mockReturnValue(scripted.socket);
      await expect(sendNotificationMail(environment, mail)).rejects.toBeInstanceOf(NotificationMailDeliveryUncertain);
    }
  });

  it("classifies a binding send rejection as uncertain, without exposing provider details", async () => {
    const send = vi.fn(async () => { throw Error("private provider detail"); });
    const binding: NonNullable<Env["NOTIFICATION_EMAIL"]> = { send };
    const enabled: Env = { ...environment, SMTP_NOTIFICATIONS_ENABLED: "false",
      NOTIFICATION_FROM: "sender@example.test", NOTIFICATION_EMAIL: binding };
    await expect(sendNotificationMail(enabled, mail)).rejects.toEqual(new NotificationMailDeliveryUncertain());
    expect(send).toHaveBeenCalledOnce();
  });

  it("classifies connection, configuration and opaque failures without inspecting private details", async () => {
    const broken = scriptedSocket({ readFailsBeforeGreeting: true });
    smtp.connect.mockReturnValue(broken.socket);
    const connection = await failure(() => sendNotificationMail(environment, mail));
    expect(notificationMailFailureCode(connection)).toBe("mail-connection-failed");

    const configuration = await failure(() => validateNotificationMailTransport({ ...environment, SMTP_PASSWORD: "" }));
    expect(notificationMailFailureCode(configuration)).toBe("mail-configuration-invalid");

    const opaque = new Proxy({}, {
      get() { throw new Error("private provider detail"); },
      getPrototypeOf() { throw new Error("private provider detail"); },
    });
    expect(notificationMailFailureCode(opaque)).toBe("mail-transport-unknown");
    expect(notificationMailFailureCode(new Error("private provider detail"))).toBe("mail-transport-unknown");
  });

  it("classifies a greeting rejection by SMTP stage instead of numeric code alone", async () => {
    const rejected = scriptedSocket({ greeting: "535 Synthetic greeting rejection\r\n" });
    smtp.connect.mockReturnValue(rejected.socket);
    const error = await failure(() => sendNotificationMail(environment, mail));
    expect(notificationMailFailureCode(error)).toBe("mail-smtp-rejected");
    expect(rejected.writes).toHaveLength(0);
  });
});

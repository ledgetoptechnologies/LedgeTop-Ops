import type { Env } from "./types";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export async function sendAdminAlert(env: Env, subject: string, detail: string): Promise<void> {
  if (!env.ALERT_EMAIL || !env.ALERT_FROM || !env.ALERT_TO) return;
  try {
    await env.ALERT_EMAIL.send({
      to: env.ALERT_TO,
      from: { email: env.ALERT_FROM, name: "LTDS Operations" },
      subject: `[LTDS] ${subject}`,
      text: detail,
      html: `<h1>${escapeHtml(subject)}</h1><p>${escapeHtml(detail)}</p>`,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "admin-alert.failed", message: error instanceof Error ? error.message : "unknown" }));
  }
}

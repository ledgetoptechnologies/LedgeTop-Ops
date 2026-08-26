/** Project Alpha owns these channels. They are contact information, never a
 * portal identity, invitation recipient, or proof of authorization. Select only
 * documented scalar fields rather than returning the source payload. */
export function businessContactChannelsSql(payloadColumn: "payload_json" | "contact.payload_json" = "payload_json"): string {
  const field = (path: string, limit: number) => `CASE WHEN json_valid(${payloadColumn}) THEN
    CASE WHEN json_type(${payloadColumn},'${path}')='text'
      AND length(json_extract(${payloadColumn},'${path}'))<=${limit}
      THEN json_extract(${payloadColumn},'${path}') END END`;
  return `${field("$.email", 320)} email,
    CASE WHEN json_valid(${payloadColumn}) THEN CASE
      WHEN json_type(${payloadColumn},'$.phone') IS NULL OR json_type(${payloadColumn},'$.phone')='null'
      THEN ${field("$.phone_number", 80)} ELSE ${field("$.phone", 80)} END END phone`;
}

export function businessContactChannels(row: { email?: unknown; phone?: unknown }): { email: string | null; phone: string | null } {
  const text = (value: unknown, limit: number): string | null => {
    if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    return value.trim() || null;
  };
  return { email: text(row.email, 320), phone: text(row.phone, 80) };
}

import path from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

export const HEALTH_FILE = "renderer-health.json";

export async function writeHealth(stateDir, state) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const destination = path.join(stateDir, HEALTH_FILE);
  const temporary = path.join(stateDir, `.${HEALTH_FILE}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ protocol: 1, updatedAt: new Date().toISOString(), state })}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function checkHealth(stateDir, staleMs, now = Date.now()) {
  const filePath = path.join(stateDir, HEALTH_FILE);
  const [details, parsed] = await Promise.all([
    stat(filePath),
    readFile(filePath, "utf8").then(JSON.parse),
  ]);
  if (parsed?.protocol !== 1 || !["starting", "polling", "processing", "idle"].includes(parsed.state)) return false;
  return now - details.mtimeMs <= staleMs;
}

import path from "node:path";
import { RendererError } from "./errors.mjs";

export const HARD_LIMITS = Object.freeze({
  imageBytes: 512 * 1024 * 1024,
  pdfBytes: 256 * 1024 * 1024,
  imagePixels: 110_000_000,
  outputBytes: 128 * 1024,
  outputWidth: 320,
  outputHeight: 240,
});

function integer(env, name, fallback, minimum, maximum) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new RendererError("invalid_config", false, `${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RendererError("invalid_config", false, `${name} is outside its safe range`);
  }
  return value;
}

function absolutePath(env, name, fallback) {
  const value = env[name] || fallback;
  if (!path.isAbsolute(value)) throw new RendererError("invalid_config", false, `${name} must be absolute`);
  return path.resolve(value);
}

export function readDecoderConfig(env = process.env) {
  const rendererVersion = env.LTDSTHUMB_RENDERER_VERSION || "truenas-0.1.0";
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(rendererVersion)) throw new RendererError("invalid_config", false, "LTDSTHUMB_RENDERER_VERSION is invalid");
  const r2RootPrefix = (env.LTDSTHUMB_R2_ROOT_PREFIX || "Jobs").replace(/\/+$/, "");
  if (r2RootPrefix !== "Jobs") throw new RendererError("invalid_config", false, "LTDSTHUMB_R2_ROOT_PREFIX must be Jobs");

  const renderRetryBaseMs = integer(env, "LTDSTHUMB_RENDER_RETRY_BASE_MS", 60_000, 1_000, 3_600_000);
  const renderRetryMaxMs = integer(env, "LTDSTHUMB_RENDER_RETRY_MAX_MS", 3_600_000, 1_000, 86_400_000);
  if (renderRetryMaxMs < renderRetryBaseMs) throw new RendererError("invalid_config", false, "LTDSTHUMB_RENDER_RETRY_MAX_MS must not be less than LTDSTHUMB_RENDER_RETRY_BASE_MS");

  return Object.freeze({
    jobsRoot: absolutePath(env, "LTDSTHUMB_JOBS_ROOT", "/data/jobs"),
    artifactsDir: absolutePath(env, "LTDSTHUMB_ARTIFACTS_DIR", "/artifacts"),
    r2RootPrefix,
    rendererVersion,
    workDir: absolutePath(env, "LTDSTHUMB_WORK_DIR", "/work/jobs"),
    cacheDir: absolutePath(env, "LTDSTHUMB_CACHE_DIR", "/cache"),
    stateDir: absolutePath(env, "LTDSTHUMB_STATE_DIR", "/state"),
    scanIntervalMs: integer(env, "LTDSTHUMB_SCAN_INTERVAL_MS", 60_000, 10_000, 3_600_000),
    pruneGraceMs: integer(env, "LTDSTHUMB_PRUNE_GRACE_MS", 86_400_000, 3_600_000, 604_800_000),
    renderTimeoutMs: integer(env, "LTDSTHUMB_RENDER_TIMEOUT_MS", 120_000, 10_000, 300_000),
    renderMaxAttempts: integer(env, "LTDSTHUMB_RENDER_MAX_ATTEMPTS", 3, 1, 10),
    renderRetryBaseMs,
    renderRetryMaxMs,
    heartbeatMs: integer(env, "LTDSTHUMB_HEARTBEAT_MS", 30_000, 10_000, 120_000),
    healthStaleMs: integer(env, "LTDSTHUMB_HEALTH_STALE_MS", 900_000, 60_000, 900_000),
    imageMaxBytes: integer(env, "LTDSTHUMB_IMAGE_MAX_BYTES", HARD_LIMITS.imageBytes, 1, HARD_LIMITS.imageBytes),
    pdfMaxBytes: integer(env, "LTDSTHUMB_PDF_MAX_BYTES", HARD_LIMITS.pdfBytes, 1, HARD_LIMITS.pdfBytes),
    imageMaxPixels: integer(env, "LTDSTHUMB_IMAGE_MAX_PIXELS", HARD_LIMITS.imagePixels, 1, HARD_LIMITS.imagePixels),
  });
}

export const readConfig = readDecoderConfig;

export function readBrokerConfig(env = process.env) {
  const ingestUrl = new URL(env.LTDSTHUMB_INGEST_URL || "https://invalid.invalid/");
  if (ingestUrl.protocol !== "https:" || ingestUrl.pathname !== "/api/internal/thumbnail-ingest/v1" || ingestUrl.search || ingestUrl.hash || ingestUrl.username || ingestUrl.password) {
    throw new RendererError("invalid_config", false, "LTDSTHUMB_INGEST_URL must be the exact HTTPS thumbnail ingest endpoint");
  }
  const ingestSecret = env.THUMBNAIL_INGEST_SECRET || "";
  const accessClientId = env.CF_ACCESS_CLIENT_ID || "";
  const accessClientSecret = env.CF_ACCESS_CLIENT_SECRET || "";
  const accountId = env.LTDSTHUMB_R2_ACCOUNT_ID || "";
  const accessKeyId = env.LTDSTHUMB_R2_ACCESS_KEY_ID || "";
  const secretAccessKey = env.LTDSTHUMB_R2_SECRET_ACCESS_KEY || "";
  const bucket = env.LTDSTHUMB_R2_BUCKET_NAME || "";
  if (ingestSecret.length < 32 || /[\r\n]/.test(ingestSecret)) throw new RendererError("invalid_config", false, "THUMBNAIL_INGEST_SECRET is invalid");
  if (accessClientId.length < 16 || accessClientId.length > 512 || /[\r\n]/.test(accessClientId) || accessClientSecret.length < 32 || accessClientSecret.length > 512 || /[\r\n]/.test(accessClientSecret)) {
    throw new RendererError("invalid_config", false, "Cloudflare Access service token configuration is invalid");
  }
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[A-Za-z0-9_-]{16,128}$/.test(accessKeyId) || secretAccessKey.length < 32 || /[\r\n]/.test(secretAccessKey)) throw new RendererError("invalid_config", false, "R2 HEAD credential configuration is invalid");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new RendererError("invalid_config", false, "LTDSTHUMB_R2_BUCKET_NAME is invalid");
  return Object.freeze({
    ingestUrl,
    ingestSecret,
    accessClientId,
    accessClientSecret,
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    rendererVersion: env.LTDSTHUMB_RENDERER_VERSION || "truenas-0.1.0",
    artifactsDir: absolutePath(env, "LTDSTHUMB_ARTIFACTS_DIR", "/artifacts"),
    stateDir: absolutePath(env, "LTDSTHUMB_STATE_DIR", "/state/broker"),
    pollIntervalMs: integer(env, "LTDSTHUMB_BROKER_POLL_MS", 5_000, 1_000, 60_000),
    settleMs: integer(env, "LTDSTHUMB_R2_SETTLE_MS", 5_000, 1_000, 60_000),
    requestTimeoutMs: integer(env, "LTDSTHUMB_REQUEST_TIMEOUT_MS", 30_000, 5_000, 120_000),
    healthStaleMs: integer(env, "LTDSTHUMB_HEALTH_STALE_MS", 900_000, 60_000, 900_000),
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { HARD_LIMITS, readBrokerConfig, readDecoderConfig } from "../src/config.mjs";

test("accepts bounded decoder defaults without credentials", () => {
  const config = readDecoderConfig({});
  assert.equal(config.imageMaxPixels, 512_000_000);
  assert.equal(config.imageMaxBytes, HARD_LIMITS.imageBytes);
  assert.equal(config.renderMaxAttempts, 3);
  assert.equal(config.renderRetryBaseMs, 60_000);
  assert.equal(config.renderRetryMaxMs, 3_600_000);
  assert.equal("agentSecret" in config, false);
});

const broker = {
  LTDSTHUMB_INGEST_URL: "https://ops.example.test/api/internal/thumbnail-ingest/v1",
  THUMBNAIL_INGEST_SECRET: "s".repeat(48), CF_ACCESS_CLIENT_ID: "i".repeat(32), CF_ACCESS_CLIENT_SECRET: "c".repeat(48),
  LTDSTHUMB_R2_ACCOUNT_ID: "a".repeat(32), LTDSTHUMB_R2_BUCKET_NAME: "client-data",
  LTDSTHUMB_R2_ACCESS_KEY_ID: "A".repeat(32), LTDSTHUMB_R2_SECRET_ACCESS_KEY: "z".repeat(48),
};

test("accepts the exact broker endpoint and HEAD credential", () => {
  assert.equal(readBrokerConfig(broker).ingestUrl.hostname, "ops.example.test");
});

test("rejects endpoint drift, weak secrets, and decoder caps above hard limits", () => {
  assert.throws(() => readBrokerConfig({ ...broker, LTDSTHUMB_INGEST_URL: "https://ops.example.test/other" }), /exact HTTPS/);
  assert.throws(() => readBrokerConfig({ ...broker, THUMBNAIL_INGEST_SECRET: "short" }), /INGEST_SECRET/);
  assert.throws(() => readBrokerConfig({ ...broker, CF_ACCESS_CLIENT_SECRET: "short" }), /Access service token/);
  assert.throws(() => readDecoderConfig({ LTDSTHUMB_IMAGE_MAX_PIXELS: "512000001" }), /safe range/);
  assert.throws(() => readDecoderConfig({ LTDSTHUMB_RENDER_RETRY_BASE_MS: "2000", LTDSTHUMB_RENDER_RETRY_MAX_MS: "1000" }), /must not be less/);
});

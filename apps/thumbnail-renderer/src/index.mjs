import { readConfig } from "./config.mjs";
import { asRendererError } from "./errors.mjs";
import { installSignalController, runWatcher, safeLog } from "./watcher.mjs";

const controller = installSignalController();
try {
  await runWatcher(readConfig(), { signal: controller.signal });
  safeLog("info", "renderer_stopped");
} catch (error) {
  const safe = asRendererError(error);
  safeLog("error", "renderer_fatal", { code: safe.code });
  process.exitCode = 1;
}

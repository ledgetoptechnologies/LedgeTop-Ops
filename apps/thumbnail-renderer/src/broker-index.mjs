import { readBrokerConfig } from "./config.mjs";
import { asRendererError } from "./errors.mjs";
import { installSignalController, runBroker, safeLog } from "./broker.mjs";

const controller = installSignalController();
try { await runBroker(readBrokerConfig(), { signal: controller.signal }); }
catch (error) { safeLog("error", "broker_fatal", { code: asRendererError(error).code }); process.exitCode = 1; }

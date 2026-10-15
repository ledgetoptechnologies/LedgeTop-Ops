export const DIRECTORY_REPLAY_ACCEPTANCE_PATH = "/administration/staging/directory-replay-acceptance";
export const RETAINED_SYNTHETIC_CLIENT_ID = "614ed50f-8800-4ab3-aa69-009d8e5cefa9";
export const isDirectoryReplayAcceptanceLocation = (location: Pick<Location, "protocol" | "hostname" | "port" | "pathname">) =>
  location.protocol === "https:" && location.hostname === "ops-staging.ledgetopdroneservices.com" && location.port === ""
  && location.pathname === DIRECTORY_REPLAY_ACCEPTANCE_PATH;

export const PROJECT_REPLAY_ACCEPTANCE_PATH = "/administration/staging/project-v2-replay-acceptance";
export const isProjectReplayAcceptanceLocation = (location: Pick<Location, "protocol" | "hostname" | "port" | "pathname">) =>
  location.protocol === "https:" && location.hostname === "ops-staging.ledgetopdroneservices.com" && location.port === ""
  && location.pathname === PROJECT_REPLAY_ACCEPTANCE_PATH;

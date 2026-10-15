import { createRoot } from "react-dom/client";
import { ReviewedImportEnrollment } from "../../src/client/ReviewedImportEnrollment";

type Call = { path: string; method: string; headers: Record<string, string>; body?: string };
type FixtureWindow = Window & { enrollmentScenario?: string; enrollmentCalls?: Call[]; changeCount?: number };
const state = window as FixtureWindow, scenario = state.enrollmentScenario ?? "success";
state.enrollmentCalls = []; state.changeCount = 0;
let posts = 0, sessions = 0;
Object.defineProperty(crypto, "randomUUID", { configurable: true,
  value: () => "11111111-1111-4111-8111-111111111111" });
window.fetch = async (input, init = {}) => {
  const headers = Object.fromEntries(new Headers(init.headers).entries()), path = String(input), method = init.method ?? "GET";
  state.enrollmentCalls!.push({ path, method, headers, ...(init.body ? { body: String(init.body) } : {}) });
  if (path.endsWith("/session")) { sessions++;
    return Response.json(scenario === "malformed-session" ? { csrfToken: "not-real", verifiedUntil: "2099-01-01T00:00:00.000Z" }
      : { csrfToken: `${100 + sessions}.${String(sessions).repeat(64)}`, verifiedUntil: "2099-01-01T00:00:00.000Z" }); }
  if (path.endsWith("/review")) {
    const sources = scenario === "empty" ? [] : [{ sourceId: "project-alpha:existing", enrolled: true }, { sourceId: "project-alpha:eligible", enrolled: false }];
    return Response.json({ review: { recordId: "record-one", kind: "client", recordVersion: 4,
      enrollmentVersion: 2, sources, ...(scenario === "malformed-review" ? { unexpected: true } : {}) } });
  }
  posts++;
  if (scenario === "conflict" && posts === 1) return Response.json({ error: "stale" }, { status: 409 });
  if (scenario === "network" && posts === 1) throw new TypeError("lost response");
  const body = JSON.parse(String(init.body));
  return Response.json({ outcome: { status: "written", replayed: posts > 1, recordId: "record-one",
    enrollmentVersion: scenario === "malformed-outcome" ? 4 : 3, sourceIds: body.sourceIds } });
};
createRoot(document.getElementById("root")!).render(<ReviewedImportEnrollment enabled={scenario !== "disabled"}
  recordId="record-one" kind="client" onChanged={() => { state.changeCount = (state.changeCount ?? 0) + 1; }} />);

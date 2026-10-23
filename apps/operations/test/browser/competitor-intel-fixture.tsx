import { createRoot } from "react-dom/client";
import { useState } from "react";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import type { CompetitorIntelCommand } from "@ltds/shared/competitor-intel";
import { CompetitorIntelIndex, CompetitorIntelTenant } from "../../src/client/CompetitorIntel";
import { sampleStaffTenant, sampleTriageRows } from "../../../../packages/shared/test-fixtures/competitor-intel-sample";

const fixtureWindow = window as Window & { ciCommands?: CompetitorIntelCommand[]; ciMode?: "ok" | "reject" | "empty" };
const commands: CompetitorIntelCommand[] = fixtureWindow.ciCommands = [];
const send = async (command: CompetitorIntelCommand) => {
  commands.push(structuredClone(command));
  if (fixtureWindow.ciMode === "reject") throw new Error("rejected");
};

function Fixture() {
  const [open, setOpen] = useState<string | null>(new URLSearchParams(location.search).get("tenant"));
  if (fixtureWindow.ciMode === "empty") return <CompetitorIntelIndex rows={[]} onOpen={setOpen} />;
  return open ? <CompetitorIntelTenant view={sampleStaffTenant} onCommand={send} onBack={() => setOpen(null)} />
    : <CompetitorIntelIndex rows={sampleTriageRows} onOpen={setOpen} />;
}
createRoot(document.getElementById("root")!).render(<main style={{ padding: "16px", maxWidth: "1200px", margin: "0 auto" }}><Fixture /></main>);

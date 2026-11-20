import { expect, it } from "vitest";
import { batteryLabel, batterySummaryLabel } from "../src/client/flight-logs/format";

it("uses the canonical reference and displays each masked serial only once", () => {
  const battery = { serial: "BATTERY0009", aircraftName: "Mini 4 Pro" };
  expect(batteryLabel(battery)).toBe("Mini 4 Pro · Battery …0009");
  expect(batteryLabel({ ...battery, referenceName: " Battery  1 " })).toBe("Mini 4 Pro · Battery 1 · SN …0009");
  expect(batteryLabel({ ...battery, referenceName: "Pack  1" })).toBe("Mini 4 Pro · Battery Pack 1 · SN …0009");
});

it("labels shared-pack summaries with both aircraft references and one serial", () => {
  const label = batterySummaryLabel({ serial: "BATTERY0009", references: [
    { aircraftName: "Mini A", referenceName: "1" }, { aircraftName: "Mini B", referenceName: "2" },
  ] });
  expect(label).toBe("Mini A · Battery 1; Mini B · Battery 2 · SN …0009");
  expect(label.match(/0009/g)).toHaveLength(1);
  expect(label).not.toContain("BATTERY0009");
});

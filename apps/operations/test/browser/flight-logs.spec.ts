import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// A small synthetic OpenDroneLog backup (no real flights): 3 flight rows, one a duplicate fingerprint.
const BACKUP = fileURLToPath(new URL("./fixtures/synthetic-odl.db.backup", import.meta.url));

interface Recorded { batches: Array<{ flights: Array<{ pilot: { id: string } }>; keychains: unknown[] }>; tracks: string[]; started: unknown[]; completed: number }

async function mock(page: Page, { permissions, flights = [], unavailable = false }: { permissions: string[]; flights?: unknown[]; unavailable?: boolean }) {
  const recorded: Recorded = { batches: [], tracks: [], started: [], completed: 0 };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: { id: "owner", email: "owner@example.com", displayName: "Owner", status: "Active", profileType: "Employee", isAdministrator: true, permissions, divisions: [] },
        csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
      return;
    }
    if (path === "/api/admin/flight-logs/flights") {
      await route.fulfill(unavailable ? { status: 503, json: { error: "Flight logs aren’t connected yet." } } : { json: { items: flights, next: null } });
      return;
    }
    if (path === "/api/admin/flight-logs/import/pilots") { await route.fulfill({ json: { items: [{ id: "owner", displayName: "Beau" }, { id: "kollin", displayName: "Kollin" }] } }); return; }
    if (path === "/api/admin/flight-logs/import/inventory") { await route.fulfill({ json: { fileHashes: [], aircraftSerials: [], batterySerials: [], controllerSerials: [] } }); return; }
    if (path === "/api/admin/flight-logs/imports" && request.method() === "POST") { recorded.started.push(request.postDataJSON()); await route.fulfill({ status: 201, json: { importId: "import-1" } }); return; }
    if (path === "/api/admin/flight-logs/imports/import-1/flights") {
      const batch = request.postDataJSON(); recorded.batches.push(batch);
      await route.fulfill({ json: { created: batch.flights.map((flight: { source: { flightId: string } }) => ({ sourceFlightId: flight.source.flightId, flightId: `stored-${flight.source.flightId}` })), existing: [], keychainsStored: batch.keychains.length } });
      return;
    }
    if (/\/api\/admin\/flight-logs\/imports\/import-1\/flights\/[^/]+\/track$/.test(path)) { recorded.tracks.push(path.split("/").at(-2)!); await route.fulfill({ json: { stored: true } }); return; }
    if (path === "/api/admin/flight-logs/imports/import-1/complete") {
      recorded.completed++;
      await route.fulfill({ json: { importId: "import-1", pilotId: "kollin", expectedFlights: 2, flightsCreated: 2, flightsExisting: 0, tracksStored: recorded.tracks.length } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return recorded;
}

test("Flight logs says plainly when the logs service isn't connected", async ({ page }) => {
  await mock(page, { permissions: ["flight_logs.view", "flight_logs.import"], unavailable: true });
  await page.goto("/fleet");
  await expect(page.getByRole("heading", { name: "Fleet & flight logs" })).toBeVisible();
  await expect(page.getByText("Flight logs aren’t connected yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import from OpenDroneLog" })).toBeDisabled();
});

test("Viewers see the flight list in plain units, without the import button", async ({ page }) => {
  await mock(page, { permissions: ["flight_logs.view"], flights: [{
    id: "f1", displayName: "Roof survey", startedAt: "2026-05-01T14:00:00Z", durationSeconds: 3900, distanceMeters: 3218.7, maxAltitudeMeters: 120,
    pilotId: "kollin", pilotName: "Kollin", media: { photos: 4, videos: 0 }, aircraft: { serial: "AIRCRAFT0001", model: "Matrice30", name: "Big Orange" }, hasTrack: true, rawLog: "missing",
  }] });
  await page.goto("/fleet");
  const row = page.getByRole("row", { name: /Roof survey/ });
  await expect(row).toContainText("Big Orange");
  await expect(row).toContainText("Kollin");
  await expect(row).toContainText("1 h 5 min");
  await expect(row).toContainText("2.0 mi");
  await expect(row).toContainText("394 ft");
  await expect(page.getByRole("button", { name: "Import from OpenDroneLog" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Importing a backup reads it locally, previews it, then sends flights and tracks for the chosen pilot", async ({ page }) => {
  const recorded = await mock(page, { permissions: ["flight_logs.view", "flight_logs.import"] });
  await page.goto("/fleet");
  await page.getByRole("button", { name: "Import from OpenDroneLog" }).click();
  await page.getByLabel("Backup file").setInputFiles(BACKUP);
  await page.getByLabel("Pilot").selectOption("kollin");
  const preview = page.getByLabel("What this import will add");
  await expect(preview).toContainText("2 new");
  await expect(preview).toContainText("Kollin");
  await expect(preview.getByText(/1 duplicate flight/)).toBeHidden(); // inside the collapsed Notes
  await page.getByRole("button", { name: "Import 2 flights for Kollin" }).click();
  await expect(page.getByText("Import finished: 2 flights added, 2 tracks saved.")).toBeVisible();
  expect(recorded.started).toEqual([{ pilotId: "kollin", expectedFlights: 2 }]);
  expect(recorded.batches).toHaveLength(1);
  expect(recorded.batches[0]!.flights.every(flight => flight.pilot.id === "kollin")).toBe(true);
  expect(recorded.batches[0]!.keychains).toHaveLength(1);
  expect(recorded.tracks.sort()).toEqual(["stored-101", "stored-102"]);
  expect(recorded.completed).toBe(1);
});

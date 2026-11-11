import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

// A small synthetic OpenDroneLog backup (no real flights): 3 flight rows, one a duplicate fingerprint.
const BACKUP = fileURLToPath(new URL("./fixtures/synthetic-odl.db.backup", import.meta.url));

const FLIGHT = {
  id: "f1", displayName: "Roof survey", fileName: "DJIFlightRecord_2026-05-01_[14-00-00].txt", startedAt: "2026-05-01T14:00:00Z", durationSeconds: 3900, distanceMeters: 3218.7,
  maxAltitudeMeters: 120, maxSpeedMetersPerSecond: 12, pilotId: "kollin", pilotName: "Kollin", media: { photos: 4, videos: 0 }, hasTrack: true, rawLog: "missing", color: null,
  home: { latitude: 45, longitude: -93 }, aircraft: { id: "a1", serial: "AIRCRAFT0001", model: "Matrice30", name: "Big Orange" }, battery: { id: "b1", serial: "BATTERY0009", lifePercent: 96 }, tags: ["Client A"],
};
const FACETS = { aircraft: [{ id: "a1", serial: "AIRCRAFT0001", model: "Matrice30", name: "Big Orange", flights: 1 }], batteries: [{ id: "b1", serial: "BATTERY0009", flights: 1 }],
  tags: [{ tag: "Client A", kind: "manual", flights: 1 }], pilots: [{ id: "kollin", pilotName: "Kollin", flights: 1 }],
  ranges: { durationSeconds: 3900, altitudeMeters: 120, distanceMeters: 3218.7, firstFlightAt: "2026-05-01T14:00:00Z", lastFlightAt: "2026-05-01T14:00:00Z" } };
const OVERVIEW = {
  totals: { flights: 1, durationSeconds: 3900, distanceMeters: 3218.7, dataPoints: 3, maxAltitudeMeters: 120, maxSpeedMetersPerSecond: 12, photos: 4, videos: 0,
    averageDistanceMeters: 3218.7, averageDurationSeconds: 3900, averageSpeedMetersPerSecond: 0.83 },
  activity: [{ day: "2026-05-01", flights: 1, durationSeconds: 3900 }], byHour: [{ hour: 14, flights: 1 }],
  byAircraft: [{ id: "a1", serial: "AIRCRAFT0001", model: "Matrice30", name: "Big Orange", flights: 1, durationSeconds: 3900 }],
  byBattery: [{ id: "b1", serial: "BATTERY0009", flights: 1, durationSeconds: 3900 }], byDuration: { short: 0, mid: 0, long: 1 },
  locations: [], batteryHealth: [{ id: "b1", serial: "BATTERY0009", cycles: 12, lifePercent: 96, flights: 1, durationSeconds: 3900 }],
  longest: [{ id: "f1", displayName: "Roof survey", startedAt: "2026-05-01T14:00:00Z", value: 3900 }], furthest: [{ id: "f1", displayName: "Roof survey", startedAt: "2026-05-01T14:00:00Z", value: 3218.7 }],
};
interface Recorded { overviews: string[]; batches: Array<{ flights: Array<{ pilot: { id: string } }>; keychains: unknown[] }>; tracks: string[]; started: unknown[]; completed: number; completions: unknown[] }

async function mock(page: Page, { permissions, flights = [], unavailable = false }: { permissions: string[]; flights?: unknown[]; unavailable?: boolean }) {
  const recorded: Recorded = { overviews: [], batches: [], tracks: [], started: [], completed: 0, completions: [] };
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
      await route.fulfill(unavailable ? { status: 503, json: { error: "Flight logs aren’t connected yet." } } : { json: { items: flights, next: null, total: flights.length } });
      return;
    }
    if (path === "/api/admin/flight-logs/facets") { await route.fulfill({ json: FACETS }); return; }
    if (path === "/api/admin/flight-logs/overview") { recorded.overviews.push(new URL(request.url()).search); await route.fulfill({ json: OVERVIEW }); return; }
    if (path === "/api/admin/flight-logs/flights/f1") { await route.fulfill({ json: { ...FLIGHT, endedAt: null, notes: null, telemetryPoints: 3, batteryCycleCount: 12, controller: null,
      tags: [{ tag: "Client A", kind: "manual" }], messages: [{ offsetMs: 100, level: "warn", text: "Strong wind" }] } }); return; }
    if (path === "/api/admin/flight-logs/flights/f1/track") { await route.fulfill({ json: { rowCount: 3, columns: {
      offsetMs: [0, 100, 200], latitude: [45, 45.0001, 45.0002], longitude: [-93, -93.0001, -93.0002], heightMeters: [0, 30, 60],
      speedMetersPerSecond: [0, 5, 10], batteryPercent: [90, 80, 70], batteryVoltage: [16.8, 16.5, 16.1] } } }); return;
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
      recorded.completed++; recorded.completions.push(request.postDataJSON());
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
  // With no service there is nothing to import into, so the import isn't offered.
  await expect(page.getByRole("button", { name: "Import from OpenDroneLog" })).toHaveCount(0);
});

test("Viewers see the flight list and fleet overview in plain units, without the import button", async ({ page }) => {
  await mock(page, { permissions: ["flight_logs.view"], flights: [FLIGHT] });
  await page.goto("/fleet");
  const item = page.locator(".flight-list").getByRole("button", { name: /Roof survey/ });
  await expect(item).toContainText("Big Orange");
  await expect(item).toContainText("Kollin");
  await expect(item).toContainText("1h 5m");
  await expect(item).toContainText("2.00 mi");
  await expect(page.getByRole("button", { name: "Import from OpenDroneLog" })).toHaveCount(0);
  const overview = page.getByRole("region", { name: "Fleet overview" });
  await expect(overview.locator(".flight-stat").filter({ hasText: "Flights" }).first()).toContainText("1");
  await expect(overview.getByText("Battery …0009").first()).toBeVisible();
  await expect(overview.getByRole("button", { name: /Roof survey/ }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Opening a flight shows its stats, telemetry charts and messages, and filters drive the overview", async ({ page }) => {
  const recorded = await mock(page, { permissions: ["flight_logs.view"], flights: [FLIGHT] });
  await page.goto("/fleet");
  await page.getByLabel("Aircraft").selectOption("a1");
  await expect.poll(() => recorded.overviews.at(-1)).toBe("?aircraft=a1");
  await page.getByRole("button", { name: /Roof survey/ }).first().click();
  const detail = page.getByRole("region", { name: "Roof survey" });
  await expect(detail.getByRole("heading", { name: "Roof survey" })).toBeVisible();
  await expect(detail.locator(".flight-stat").filter({ hasText: "Max height" })).toContainText("394 ft");
  await expect(detail.locator(".flight-stat").filter({ hasText: "Min battery" })).toContainText("70%");
  await expect(detail.getByText("Battery …0009")).toBeVisible();
  await expect(detail.getByRole("img", { name: /Height and speed over the flight/ })).toBeVisible();
  await expect(detail.getByRole("img", { name: /Battery over the flight/ })).toBeVisible();
  await expect(detail.getByText("Strong wind")).toBeVisible();
  // Without a map key the map says so instead of failing.
  await expect(detail.getByText("The map isn’t available: Operations has no map key configured.")).toBeVisible();
  await expect(detail.getByRole("button", { name: "GPX" })).toBeVisible();
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
  expect(recorded.completions).toEqual([{ tracksExpected: 2 }]);
});

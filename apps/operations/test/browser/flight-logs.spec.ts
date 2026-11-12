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
  locations: [{ id: "f1", displayName: "Roof survey", startedAt: "2026-05-01T14:00:00Z", latitude: 45, longitude: -93 }],
  batteryHealth: [{ id: "b1", serial: "BATTERY0009", cycles: 12, lifePercent: 96, flights: 1, durationSeconds: 3900 }],
  longest: [{ id: "f1", displayName: "Roof survey", startedAt: "2026-05-01T14:00:00Z", value: 3900 }], furthest: [{ id: "f1", displayName: "Roof survey", startedAt: "2026-05-01T14:00:00Z", value: 3218.7 }],
};
interface Recorded { decisions: string[]; tiles: number; overviews: string[]; batches: Array<{ flights: Array<{ pilot: { id: string } }>; keychains: unknown[] }>; tracks: string[]; started: unknown[]; completed: number; completions: unknown[] }

async function mock(page: Page, { permissions, flights = [], unavailable = false, signIns = null, usernames = null }: { permissions: string[]; flights?: unknown[]; unavailable?: boolean; signIns?: Array<{ id: string; code: string; model: string }> | null; usernames?: Array<{ id: string; displayName: string; username: string | null }> | null }) {
  const recorded: Recorded & { usernamePuts?: unknown[] } = { usernamePuts: [], decisions: [], tiles: 0, overviews: [], batches: [], tracks: [], started: [], completed: 0, completions: [] };
  // Basemap tiles come from Esri; tests never reach the internet.
  await page.route("https://server.arcgisonline.com/**", route => { recorded.tiles++; return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5e0000000049454e44ae426082", "hex") }); });
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
    if (path === "/api/flight-logs/controller-sign-ins" && signIns) { await route.fulfill({ json: { username: "bkoltz", items: signIns } }); return; }
    if (path === "/api/flight-logs/controllers" && signIns) { await route.fulfill({ json: { items: [{ id: "d1", pilotId: "owner", model: "DJI RC PLUS 2", name: "rc701", status: "active", signedInAt: "2026-11-12T13:00:00Z", lastSeenAt: "2026-11-12T13:50:00Z", rawLogs: 13 }] } }); return; }
    if (path === "/api/admin/flight-logs/usernames") { await route.fulfill(usernames ? { json: { items: usernames } } : { status: 403, json: { error: "Only administrators can manage controller usernames." } }); return; }
    const usernamePut = /^\/api\/admin\/flight-logs\/usernames\/([^/]+)$/.exec(path);
    if (usernamePut && request.method() === "PUT" && usernames) {
      const body = request.postDataJSON() as { username: string | null };
      recorded.usernamePuts!.push([usernamePut[1], body.username]);
      if (body.username === "bkoltz") { await route.fulfill({ status: 409, json: { error: "Someone else already has that username." } }); return; }
      const person = usernames.find(p => p.id === usernamePut[1]); if (person) person.username = body.username;
      await route.fulfill({ json: { id: usernamePut[1], username: body.username } }); return;
    }
    const decision = /^\/api\/flight-logs\/controller-sign-ins\/([^/]+)\/(approve|deny)$/.exec(path);
    if (decision && request.method() === "POST") { recorded.decisions.push(`${decision[1]}:${decision[2]}`); if (signIns) signIns.splice(0); await route.fulfill({ json: { status: decision[2] === "approve" ? "approved" : "denied" } }); return; }
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
  const recorded = await mock(page, { permissions: ["flight_logs.view"], flights: [FLIGHT] });
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
  await expect(overview.getByRole("region", { name: "Map of 1 flight home points" })).toBeVisible();
  await expect(overview.locator(".leaflet-control-attribution").first()).toContainText("Esri");
  expect(recorded.tiles).toBeGreaterThan(0);
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
  // The map needs no key: Esri tiles (stubbed here) under a Leaflet map with the coloured track.
  await expect(detail.getByRole("region", { name: "Flight path map" })).toBeVisible();
  await expect(detail.locator(".leaflet-attribution-flag, .leaflet-control-attribution").first()).toContainText("Esri");
  expect(recorded.tiles).toBeGreaterThan(0);
  await expect(detail.getByRole("button", { name: "GPX" })).toBeVisible();
});

test("A controller sign-in addressed to you shows its code and is approved as you; your controllers are listed", async ({ page }) => {
  const recorded = await mock(page, { permissions: ["flight_logs.view"], flights: [FLIGHT], signIns: [{ id: "s1", code: "KXT-482", model: "DJI RC PLUS 2" }] });
  await page.goto("/fleet");
  const request = page.getByRole("alert").filter({ hasText: "Controller sign-in" });
  await expect(request).toContainText("KXT-482");
  await expect(request).toContainText("wants to sign in as you (bkoltz)");
  await request.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Approved" })).toBeVisible();
  expect(recorded.decisions).toEqual(["s1:approve"]);
  await expect(page.getByRole("alert").filter({ hasText: "Controller sign-in" })).toHaveCount(0);
  await page.getByText("Controllers", { exact: false }).first().click();
  await expect(page.getByText("13 logs uploaded", { exact: false })).toBeVisible();
  await expect(page.getByText("type bkoltz", { exact: false })).toBeVisible();
});

test("Administrators set each pilot's controller username; others never see the section", async ({ page }) => {
  const recorded = await mock(page, { permissions: ["flight_logs.view"], flights: [FLIGHT], usernames: [{ id: "owner", displayName: "Beau", username: "bkoltz" }, { id: "kollin", displayName: "Kollin", username: null }] });
  await page.goto("/fleet");
  const section = page.locator("details.flight-usernames");
  await expect(section).toContainText("1 without one");
  await section.locator("summary").click();
  const kollin = section.getByLabel("Kollin");
  await kollin.fill("bkoltz");
  await section.getByRole("button", { name: "Save" }).nth(1).click();
  await expect(section.getByRole("status")).toContainText("Someone else already has that username.");
  await kollin.fill(" KStirn ");
  await section.getByRole("button", { name: "Save" }).nth(1).click();
  await expect(section.getByRole("status")).toContainText("Kollin signs in on controllers as kstirn.");
  await expect(section).toContainText("everyone has one");
  expect(recorded.usernamePuts).toEqual([["kollin", "bkoltz"], ["kollin", "kstirn"]]);
});

test("People who can't manage usernames don't see the usernames section", async ({ page }) => {
  await mock(page, { permissions: ["flight_logs.view"], flights: [FLIGHT] });
  await page.goto("/fleet");
  await expect(page.getByRole("heading").or(page.locator(".flight-main")).first()).toBeVisible();
  await expect(page.locator("details.flight-usernames")).toHaveCount(0);
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

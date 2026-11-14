import { describe, expect, it } from "vitest";
import { BATCH_BYTES, FLIGHTS_PER_BATCH, FlightTooLargeError, OPS_BATCH_BYTES, batches, preflightBatches, groupMessages } from "../src/client/flight-logs-import";
import { FLIGHT_LOG_LIMITS } from "../src/worker/flight-logs-routes";

type Plan = Parameters<typeof batches>[0];
const flight = (id: number) => ({ source: { flightId: String(id), fileHash: id.toString(16).padStart(64, "0") } });
const plan = (count: number) => ({ flights: Array.from({ length: count }, (_, i) => flight(i + 1)), messages: [] }) as unknown as Plan;
const parse = (body: string) => JSON.parse(body) as { flights: Array<{ source: { flightId: string } }>; messages: Array<{ sourceFlightId: string }> };

describe("ODL import request batches", () => {
  it("keep each request small: at most FLIGHTS_PER_BATCH flights, every flight once, in plan order", () => {
    const sent = [...batches(plan(97), new Map(), new Map())].map(batch => parse(batch.body));
    expect(FLIGHTS_PER_BATCH).toBeLessThanOrEqual(20);
    expect(sent.every(body => body.flights.length <= FLIGHTS_PER_BATCH)).toBe(true);
    expect(sent.flatMap(body => body.flights.map(f => f.source.flightId))).toEqual(Array.from({ length: 97 }, (_, i) => String(i + 1)));
  });

  it("start a new request before about BATCH_BYTES, and send a flight bigger than that alone with all its messages", () => {
    const text = "x".repeat(1000), messagesByFlight = new Map<string, Plan["messages"]>();
    const big = Array.from({ length: Math.ceil((BATCH_BYTES * 1.5) / 1000) }, (_, i) => ({ sourceFlightId: "2", offsetMs: i, level: "tip", text }));
    const small = Array.from({ length: 300 }, (_, i) => ({ sourceFlightId: "1", offsetMs: i, level: "tip", text }));
    messagesByFlight.set("2", big as unknown as Plan["messages"]);
    messagesByFlight.set("1", small as unknown as Plan["messages"]);
    messagesByFlight.set("3", small.map(m => ({ ...m, sourceFlightId: "3" })) as unknown as Plan["messages"]);
    const sent = [...batches(plan(3), messagesByFlight, new Map())];
    const bodies = sent.map(batch => parse(batch.body));
    expect(bodies.map(body => body.flights.map(f => f.source.flightId))).toEqual([["1"], ["2"], ["3"]]);
    expect(bodies[1]?.messages).toHaveLength(big.length);
    expect(sent.filter((_, i) => i !== 1).every(batch => new TextEncoder().encode(batch.body).byteLength <= BATCH_BYTES)).toBe(true);
    expect(preflightBatches(plan(3), messagesByFlight, new Map())).toBe(3);
    const stopped = new AbortController(); stopped.abort();
    expect(() => preflightBatches(plan(3), messagesByFlight, new Map(), stopped.signal)).toThrow();
  });

  it("refuse, before anything is sent, a flight whose request would exceed the Ops route's limit", () => {
    expect(OPS_BATCH_BYTES).toBe(FLIGHT_LOG_LIMITS.batchBytes);
    const text = "é".repeat(1000), messagesByFlight = new Map<string, Plan["messages"]>();
    // ~2 bytes per character in UTF-8: about 9 MB, over the 8 MB limit, though under 8 M characters.
    messagesByFlight.set("2", Array.from({ length: 4600 }, (_, i) => ({ sourceFlightId: "2", offsetMs: i, level: "tip", text })) as unknown as Plan["messages"]);
    expect(() => preflightBatches(plan(3), messagesByFlight, new Map())).toThrow(FlightTooLargeError);
    expect(() => preflightBatches(plan(3), messagesByFlight, new Map())).toThrow(/Nothing was imported/);
  });

  it("group messages by flight in one pass, keeping backup order", () => {
    const messages = [1, 2, 1, 3, 1].map((id, i) => ({ sourceFlightId: String(id), offsetMs: i, level: "tip", text: `m${i}` })) as unknown as Plan["messages"];
    const grouped = groupMessages(messages);
    expect([...grouped.keys()]).toEqual(["1", "2", "3"]);
    expect(grouped.get("1")?.map(m => m.offsetMs)).toEqual([0, 2, 4]);
  });
});

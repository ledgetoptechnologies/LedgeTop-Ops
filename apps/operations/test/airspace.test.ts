import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bbox, intersectsWI, suaStatus, tfrStatus } from "../src/worker/airspace";

describe("FAA status normalization",()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-07-16T18:00:00Z"));});afterEach(()=>vi.useRealTimers());
  it("keeps TFR lifecycle states explicit",()=>{expect(tfrStatus("2026-07-16T17:00:00Z","2026-07-16T19:00:00Z")).toBe("active");expect(tfrStatus("2026-07-17T17:00:00Z","2026-07-17T19:00:00Z")).toBe("scheduled");expect(tfrStatus("2026-07-15T17:00:00Z","2026-07-15T19:00:00Z")).toBe("expired");expect(tfrStatus(null,null)).toBe("unknown");});
  it("never calls a missing SUA reservation inactive",()=>{expect(suaStatus(null,null,null)).toBe("not_listed");expect(suaStatus("HOT","2026-07-16T17:00:00Z","2026-07-16T19:00:00Z")).toBe("active");expect(suaStatus("WAITING TO START","2026-07-16T19:00:00Z","2026-07-16T21:00:00Z")).toBe("upcoming");expect(suaStatus("PENDING APPROVAL","2026-07-16T19:00:00Z","2026-07-16T21:00:00Z")).toBe("pending");});
});

describe("Wisconsin geometry prefilter",()=>{
  it("finds polygon bounds that cross the state",()=>{const box=bbox({type:"Polygon",coordinates:[[[-93,44],[-90,44],[-90,46],[-93,46],[-93,44]]]});expect(box).toEqual({minLon:-93,maxLon:-90,minLat:44,maxLat:46});expect(intersectsWI(box)).toBe(true);});
  it("rejects a distant polygon",()=>{expect(intersectsWI(bbox({type:"Polygon",coordinates:[[[-105,39],[-104,39],[-104,40],[-105,40],[-105,39]]]}))).toBe(false);});
});

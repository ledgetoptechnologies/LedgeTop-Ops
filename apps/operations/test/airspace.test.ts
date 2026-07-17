import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { airspaceRetentionCutoff, bbox, intersectsWI, isWisconsinSua, isWisconsinTfr, regionalWfsUrl, suaStatus, tfrStatus } from "../src/worker/airspace";

describe("FAA status normalization",()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-07-16T18:00:00Z"));});afterEach(()=>vi.useRealTimers());
  it("keeps TFR lifecycle states explicit",()=>{expect(tfrStatus("2026-07-16T17:00:00Z","2026-07-16T19:00:00Z")).toBe("active");expect(tfrStatus("2026-07-17T17:00:00Z","2026-07-17T19:00:00Z")).toBe("scheduled");expect(tfrStatus("2026-07-15T17:00:00Z","2026-07-15T19:00:00Z")).toBe("expired");expect(tfrStatus(null,null)).toBe("unknown");});
  it("never calls a missing SUA reservation inactive",()=>{expect(suaStatus(null,null,null)).toBe("not_listed");expect(suaStatus("HOT","2026-07-16T17:00:00Z","2026-07-16T19:00:00Z")).toBe("active");expect(suaStatus("WAITING TO START","2026-07-16T19:00:00Z","2026-07-16T21:00:00Z")).toBe("upcoming");expect(suaStatus("PENDING APPROVAL","2026-07-16T19:00:00Z","2026-07-16T21:00:00Z")).toBe("pending");});
});

describe("Wisconsin geometry prefilter",()=>{
  it("finds polygon bounds that cross the state",()=>{const box=bbox({type:"Polygon",coordinates:[[[-93,44],[-90,44],[-90,46],[-93,46],[-93,44]]]});expect(box).toEqual({minLon:-93,maxLon:-90,minLat:44,maxLat:46});expect(intersectsWI(box)).toBe(true);});
  it("rejects a distant polygon",()=>{expect(intersectsWI(bbox({type:"Polygon",coordinates:[[[-105,39],[-104,39],[-104,40],[-105,40],[-105,39]]]}))).toBe(false);});
  it("keeps a Wisconsin-tagged TFR even when it has no geometry",()=>{expect(isWisconsinTfr({state:"WI"})).toBe(true);});
  it("rejects nationwide and other-state TFR rows without Wisconsin geometry",()=>{expect(isWisconsinTfr({state:"USA"})).toBe(false);expect(isWisconsinTfr({STATE:"MN"})).toBe(false);});
  it("keeps a TFR whose mapped geometry intersects Wisconsin",()=>{expect(isWisconsinTfr({state:"USA"},[{type:"Feature",geometry:{type:"Polygon",coordinates:[[[-90,44],[-89,44],[-89,45],[-90,45],[-90,44]]]},properties:{STATE:"USA"}}])).toBe(true);});
  it("limits SUA ingestion to Wisconsin SAA records, including MOAs",()=>{expect(isWisconsinSua({state:"WI",type_class:"SAA",airspace_type:"M"})).toBe(true);expect(isWisconsinSua({state:"MI",type_class:"SAA",airspace_type:"M"})).toBe(false);expect(isWisconsinSua({state:"WI",type_class:"TFR"})).toBe(false);});
});

describe("FAA WFS request",()=>{
  it("bounds the source request to Wisconsin without unsupported pagination",()=>{const url=new URL(regionalWfsUrl("https://sua.faa.gov/geoserver/wfs?service=WFS"));expect(url.searchParams.get("bbox")).toBe("-92.89,42.49,-86.25,47.31,EPSG:4326");expect(url.searchParams.get("maxFeatures")).toBe("1000");expect(url.searchParams.has("startIndex")).toBe(false);expect(url.searchParams.has("count")).toBe(false);});
});

describe("airspace retention",()=>{
  it("keeps expired operational records for only 24 hours",()=>{expect(airspaceRetentionCutoff(new Date("2026-07-17T18:00:00Z").getTime())).toBe("2026-07-16T18:00:00.000Z");});
});

import { describe,expect,it,vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { deliverySourceUrl } from "../src/worker/delivery";
import { isFrameableOperationsPdfRequest } from "../src/worker/frame-policy";
import { servePdfSourceFile, serveSourceFile, type SourceBucket } from "../src/worker/source-file";

function request(method="GET",headers:Record<string,string>={}){
  const normalized=new Map(Object.entries(headers).map(([name,value])=>[name.toLowerCase(),value]));
  return{method,header:(name:string)=>normalized.get(name.toLowerCase())};
}

function bucket(body="pdf body"){
  return{
    head:vi.fn(async()=>({size:8,httpEtag:'"source-etag"'})),
    get:vi.fn(async()=>({body})),
  } satisfies SourceBucket;
}

describe("Operations source file serving",()=>{
  it("streams an inline PDF with its original identity and MIME type",async()=>{
    const storage=bucket();
    const response=await servePdfSourceFile(storage,"Jobs/Clients/example/document.pdf",request());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="document.pdf"');
    expect(response.headers.get("ETag")).toBe('"source-etag"');
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("pdf body");
    expect(storage.get).toHaveBeenCalledWith("Jobs/Clients/example/document.pdf",undefined);
  });

  it("preserves byte-range and conditional response behavior",async()=>{
    const storage=bucket();
    const partial=await serveSourceFile(storage,"Jobs/example.pdf",request("GET",{Range:"bytes=2-5"}),"inline");
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/8");
    expect(partial.headers.get("Content-Length")).toBe("4");
    expect(storage.get).toHaveBeenCalledWith("Jobs/example.pdf",{range:{offset:2,length:4}});

    const unchanged=await serveSourceFile(storage,"Jobs/example.pdf",request("GET",{"If-None-Match":'"source-etag"'}),"inline");
    expect(unchanged.status).toBe(304);
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it("answers HEAD without a body and reports missing R2 objects",async()=>{
    const storage=bucket();
    const head=await servePdfSourceFile(storage,"Jobs/example.pdf",request("HEAD"));
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("8");
    expect(storage.get).not.toHaveBeenCalled();

    const missingHead={head:vi.fn(async()=>null),get:vi.fn()} satisfies SourceBucket;
    await expect(servePdfSourceFile(missingHead,"Jobs/missing.pdf",request())).rejects.toMatchObject({status:404});
    expect(missingHead.get).not.toHaveBeenCalled();

    const missingBody={head:vi.fn(async()=>({size:8,httpEtag:'"source-etag"'})),get:vi.fn(async()=>null)} satisfies SourceBucket;
    await expect(servePdfSourceFile(missingBody,"Jobs/missing.pdf",request())).rejects.toMatchObject({status:404});
  });

  it("rejects non-PDF files from the PDF-only route",()=>{
    expect(()=>servePdfSourceFile(bucket(),"Jobs/example.jpg",request())).toThrowError(HTTPException);
    try{servePdfSourceFile(bucket(),"Jobs/example.jpg",request())}catch(error){expect((error as HTTPException).status).toBe(415)}
  });

  it("uses the PDF route only for PDF listing source URLs",()=>{
    expect(deliverySourceUrl("pdf","pdf-ref")).toBe("/api/delivery/items/pdf-ref/pdf");
    expect(deliverySourceUrl("image","image-ref")).toBe("/api/delivery/items/image-ref/source");
    expect(deliverySourceUrl("other","other-ref")).toBeUndefined();
  });

  it("allows framing only for GET and HEAD requests to the PDF route",()=>{
    const path="/api/delivery/items/pdf-ref/pdf";
    expect(isFrameableOperationsPdfRequest("GET",path)).toBe(true);
    expect(isFrameableOperationsPdfRequest("HEAD",path)).toBe(true);
    expect(isFrameableOperationsPdfRequest("POST",path)).toBe(false);
    expect(isFrameableOperationsPdfRequest("GET","/api/delivery/items/pdf-ref/source")).toBe(false);
    expect(isFrameableOperationsPdfRequest("GET","/api/session")).toBe(false);
  });
});

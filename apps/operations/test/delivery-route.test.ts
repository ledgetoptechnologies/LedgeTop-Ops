import {describe,expect,it} from "vitest";
import {DELIVERY_JOBS_PREFIX,DELIVERY_ROOT_PREFIX,deliveryPathFromPrefix,prefixFromDeliveryPath} from "../src/client/delivery-route";

describe("Operations delivery routes",()=>{
  it("maps the delivery root",()=>{
    expect(prefixFromDeliveryPath("/delivery")).toBe(DELIVERY_ROOT_PREFIX);
    expect(deliveryPathFromPrefix(DELIVERY_ROOT_PREFIX)).toBe("/delivery");
  });

  it("maps the true Jobs root without changing the default Client delivery root",()=>{
    expect(prefixFromDeliveryPath("/jobs")).toBe(DELIVERY_JOBS_PREFIX);
    expect(deliveryPathFromPrefix(DELIVERY_JOBS_PREFIX)).toBe("/jobs");
    expect(prefixFromDeliveryPath("/jobs/Archive/2024")).toBe("Jobs/Archive/2024/");
    expect(deliveryPathFromPrefix("Jobs/Archive/2024/")).toBe("/jobs/Archive/2024");
    expect(prefixFromDeliveryPath("/delivery")).toBe(DELIVERY_ROOT_PREFIX);
  });

  it("round trips encoded folder segments",()=>{
    const prefix="Jobs/Clients/D&T Construction/Current Projects/700 Pilgrim Way, Green Bay/";
    const path=deliveryPathFromPrefix(prefix);
    expect(path).toBe("/delivery/D%26T%20Construction/Current%20Projects/700%20Pilgrim%20Way%2C%20Green%20Bay");
    expect(prefixFromDeliveryPath(path)).toBe(prefix);
  });

  it("preserves Unicode and URL-sensitive characters",()=>{
    const prefix="Jobs/Clients/Café #1/100% Complete?/";
    expect(prefixFromDeliveryPath(deliveryPathFromPrefix(prefix))).toBe(prefix);
  });

  it("rejects unsafe and reserved route segments",()=>{
    expect(prefixFromDeliveryPath("/delivery/Acme/%2Fsecret")).toBe(DELIVERY_ROOT_PREFIX);
    expect(prefixFromDeliveryPath("/delivery/Acme/..")).toBe(DELIVERY_ROOT_PREFIX);
    expect(prefixFromDeliveryPath("/delivery/Acme/.previews")).toBe(DELIVERY_ROOT_PREFIX);
    expect(prefixFromDeliveryPath("/delivery/Acme/%E0%A4%A")).toBe(DELIVERY_ROOT_PREFIX);
    expect(deliveryPathFromPrefix("Jobs/Demo/Acme/")).toBe("/jobs/Demo/Acme");
    expect(deliveryPathFromPrefix("Other/Demo/Acme/")).toBe("/delivery");
    expect(prefixFromDeliveryPath("/jobs/../secret")).toBe(DELIVERY_JOBS_PREFIX);
    expect(prefixFromDeliveryPath("/jobs/.previews/secret")).toBe(DELIVERY_JOBS_PREFIX);
  });
});

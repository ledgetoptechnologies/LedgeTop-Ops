// Node-only test primitive. Production requires Workerd's native FixedLengthStream;
// this shim does not qualify native framing (the real Workerd suite does).
import { afterEach, beforeEach, vi } from "vitest";
class NodeTestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let count = 0;
    super({ transform(chunk, output) {
      count += chunk.byteLength;
      if (count > length) throw Error("employee_read_interrupted");
      output.enqueue(chunk);
    }, flush() { if (count !== length) throw Error("employee_read_interrupted"); } });
  }
}
beforeEach(() => vi.stubGlobal("FixedLengthStream", NodeTestFixedLengthStream));
afterEach(() => vi.unstubAllGlobals());

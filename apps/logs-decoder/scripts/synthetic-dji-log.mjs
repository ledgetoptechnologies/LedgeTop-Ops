// Writes a fully synthetic DJI flight log (format version 6: raw, unencrypted records, no DJI key needed).
// Layout per dji-log-parser v0.5.7: 100-byte prefix {detail_offset u64, detail_length u16, version u8, ...},
// records from byte 100 to detail_offset, then the details block. No real flight data.
import fs from 'node:fs';
const [out, countArg] = process.argv.slice(2);
const count = Number(countArg ?? 600), size = 60;
const records = Buffer.alloc(count * (size + 3));
for (let i = 0; i < count; i++) {
  const at = i * (size + 3);
  records[at] = 1; records[at + 1] = size; // OSD, u8 length (version <= 12)
  const p = records.subarray(at + 2, at + 2 + size);
  p.writeDoubleLE((-100 + i * 1e-5) * Math.PI / 180, 0); // longitude (radians)
  p.writeDoubleLE((45 + i * 1e-5) * Math.PI / 180, 8);   // latitude (radians)
  p.writeInt16LE(Math.min(i, 1200), 16);                  // altitude, decimetres
  records[at + 2 + size] = 0xff;
}
const prefix = Buffer.alloc(100);
const detailOffset = 100 + records.length;
prefix.writeBigUInt64LE(BigInt(detailOffset), 0);
prefix.writeUInt16LE(400, 8);
prefix[10] = 6;
fs.writeFileSync(out, Buffer.concat([prefix, records, Buffer.alloc(400)]));
console.log(`wrote ${out}: ${detailOffset + 400} bytes, ${count} OSD records`);

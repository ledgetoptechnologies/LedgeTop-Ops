'use strict';

// Builds a small, valid, uncompressed ZIP for tests. The returned Buffer
// carries `zipEntries` ([{ relativePath, byteSize }]) for the file entries.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const fileName = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    locals.push(local, fileName, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...locals, directory, end]);
  zip.zipEntries = Object.entries(files).map(([name, value]) => ({
    relativePath: name,
    byteSize: (Buffer.isBuffer(value) ? value : Buffer.from(String(value))).length,
  }));
  return zip;
}

// One-entry ZIP whose single file holds `text`; equal-length texts give
// equal-size archives, which the same-size replacement tests rely on.
function zipOf(text) {
  return storedZip({ 'backup/payload.bin': Buffer.from(String(text)) });
}

module.exports = { crc32, storedZip, zipOf };

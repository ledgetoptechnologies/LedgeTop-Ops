// Fixed-artifact read-only PE import observation. No load or helper execution.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function inspectQualifiedPe(bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2') throw new Error('Unreviewed helper bytes');
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24;
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Expected qualified PE32+ AMD64 image');
  const sectionCount = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20);
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = optional + optionalSize + index * 40;
    return { name: bytes.toString('ascii', at, at + 8).replace(/\0.*$/, ''), rva: bytes.readUInt32LE(at + 12), rawSize: bytes.readUInt32LE(at + 16), rawOffset: bytes.readUInt32LE(at + 20) };
  });
  function offset(rva) {
    const section = sections.find(item => rva >= item.rva && rva - item.rva < item.rawSize);
    if (!section) throw new Error('Unmapped import RVA');
    return section.rawOffset + rva - section.rva;
  }
  function string(rva) {
    const at = offset(rva), end = bytes.indexOf(0, at);
    if (end < at || end - at > 1024) throw new Error('Unterminated import string');
    return bytes.toString('ascii', at, end);
  }
  const directories = Array.from({ length: bytes.readUInt32LE(optional + 108) }, (_, index) => ({ rva: bytes.readUInt32LE(optional + 112 + index * 8), size: bytes.readUInt32LE(optional + 116 + index * 8) }));
  const imports = [];
  const directory = directories[1];
  if (directory.rva) {
    const start = offset(directory.rva);
    for (let at = start; at + 20 <= start + directory.size; at += 20) {
      if (bytes.subarray(at, at + 20).every(byte => byte === 0)) break;
      const dll = string(bytes.readUInt32LE(at + 12));
      let thunk = offset(bytes.readUInt32LE(at) || bytes.readUInt32LE(at + 16));
      const symbols = [];
      for (let index = 0; index < 10000; index++, thunk += 8) {
        const value = bytes.readBigUInt64LE(thunk);
        if (!value) break;
        symbols.push(value >> 63n ? `ordinal:${value & 0xffffn}` : string(Number(value) + 2));
      }
      imports.push({ dll, symbols });
    }
  }
  return { schemaVersion: 1, helperSha256: sha256, architecture: 'AMD64', format: 'PE32+', imports, delayImportDirectory: directories[13], completeNativeProvenance: false, limitations: ['PE import tables enumerate declared DLL imports, not statically linked native libraries or DLLs loaded dynamically by name.', 'CGO_ENABLED=1 and these imports do not identify the builder C compiler/runtime or establish linked native license completeness.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/windows-helper-pe-imports.mjs <qualified-local-cloudflared.exe>');
  console.log(JSON.stringify(inspectQualifiedPe(readFileSync(process.argv[2])), null, 2));
}

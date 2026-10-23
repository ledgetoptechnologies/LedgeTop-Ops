// Offline inventory of the *pinned* cloudflared build, never execution. Not a
// general executable parser or an assertion that these modules cover CGO libs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function inspectQualifiedHelper(bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2') throw new Error('Unreviewed helper bytes');
  const magic = Buffer.from([255, ...Buffer.from(' Go buildinf:')]);
  const offsets = [];
  for (let offset = bytes.indexOf(magic); offset !== -1; offset = bytes.indexOf(magic, offset + 1)) {
    if (offset % 16 === 0 && bytes[offset + 14] === 8 && bytes[offset + 15] === 2) offsets.push(offset);
  }
  if (offsets.length !== 1) throw new Error('Expected one aligned little-endian x64 Go inline build-info header');
  let cursor = offsets[0] + 32;
  function string() {
    let length = 0, multiplier = 1, complete = false;
    for (let i = 0; i < 5 && cursor < bytes.length; i++) {
      const byte = bytes[cursor++]; length += (byte & 127) * multiplier;
      if (byte < 128) { complete = true; break; }
      multiplier *= 128;
    }
    if (!complete || length > 1024 * 1024 || cursor + length > bytes.length) throw new Error('Invalid bounded Go build-info string');
    const value = bytes.subarray(cursor, cursor + length); cursor += length;
    return value;
  }
  const goVersion = string().toString('utf8');
  const framed = string();
  if (framed.length < 33 || framed[framed.length - 17] !== 10) throw new Error('Missing Go module-info framing');
  const moduleInfo = framed.subarray(16, -16).toString('utf8');
  const lines = moduleInfo.trimEnd().split('\n').map(line => line.split('\t'));
  const modules = [];
  let previous;
  for (const row of lines) {
    if (row[0] === 'dep') { previous = { path: row[1], version: row[2], sum: row[3] }; modules.push(previous); }
    else if (row[0] === '=>') {
      if (!previous || previous.replacement) throw new Error('Unattached or repeated module replacement');
      previous.replacement = { path: row[1], version: row[2], sum: row[3] };
    } else previous = undefined;
  }
  return {
    schemaVersion: 1, helperSha256: sha256, helperBytes: bytes.length, goVersion,
    mainPackage: lines.find(row => row[0] === 'path')?.[1],
    mainModule: lines.find(row => row[0] === 'mod')?.slice(1),
    modules,
    settings: lines.filter(row => row[0] === 'build').map(row => row.slice(1).join('\t')),
    moduleInfoSha256: createHash('sha256').update(moduleInfo).digest('hex'),
    completeThirdPartyAttribution: false,
    limitations: ['Embedded Go module metadata does not enumerate linked native CGO libraries or every source-level subcomponent.', 'Module names/versions/checksums are an attribution worklist, not collected license texts or a license-compliance conclusion.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/windows-helper-buildinfo.mjs <qualified-local-cloudflared.exe>');
  console.log(JSON.stringify(inspectQualifiedHelper(readFileSync(process.argv[2])), null, 2));
}

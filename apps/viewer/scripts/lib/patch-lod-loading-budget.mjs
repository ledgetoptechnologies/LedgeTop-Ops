import fs from 'node:fs';
import path from 'node:path';

export function patchLodLoadingBudget(packageRoot) {
  const file = path.join(packageRoot, 'src/core/renderer/tiles/TilesRendererBase.js');
  const upstream = '\t\t\t\treturn parseQueue.add( tile, parseTile => {';
  const patched = '\t\t\t\tthis.__ltdsLoadingBudget?.bodyReady( tile, content );\n' + upstream;
  const hookMarker = 'this.__ltdsLoadingBudget?.bodyReady(';
  let source = fs.readFileSync(file, 'utf8');
  const sourceHookCount = source.split(hookMarker).length - 1;
  const sourcePatchedCount = source.split(patched).length - 1;
  if (source.split(upstream).length !== 2
    || !((sourceHookCount === 0 && sourcePatchedCount === 0)
      || (sourceHookCount === 1 && sourcePatchedCount === 1))) {
    throw new Error('loading body hook: unexpected renderer source count or placement');
  }
  if (sourceHookCount === 0) {
    fs.writeFileSync(file, source.replace(upstream, patched));
  }
  let count = 0;
  for (const name of fs.readdirSync(path.join(packageRoot, 'build')).filter(n => /^renderer-.*\.js$/.test(n))) {
    const built = path.join(packageRoot, 'build', name);
    source = fs.readFileSync(built, 'utf8');
    const pattern = /([\w$]+)\.internal\.loadingState = 3, ([\w$]+)\.add\(\1, \(([\w$]+)\) => ([\w$]+)\.aborted \? Promise\.resolve\(\) : ([\w$]+) === "json" && ([\w$]+)\.root/g;
    const patchedPattern = /([\w$]+)\.internal\.loadingState = 3, this\.__ltdsLoadingBudget\?\.bodyReady\(\1, ([\w$]+)\), ([\w$]+)\.add\(\1, \(([\w$]+)\) => ([\w$]+)\.aborted \? Promise\.resolve\(\) : ([\w$]+) === "json" && \2\.root/g;
    const matches = [...source.matchAll(pattern)];
    const patchedMatches = [...source.matchAll(patchedPattern)];
    const hookCount = source.split(hookMarker).length - 1;
    if (hookCount || patchedMatches.length) {
      if (hookCount !== 1 || patchedMatches.length !== 1 || matches.length !== 0) {
        throw new Error('loading body hook: unexpected built renderer count or placement');
      }
      count++;
      continue;
    }
    if (matches.length === 0) continue;
    if (matches.length !== 1) throw new Error('loading body hook: ambiguous built renderer');
    const [match, tile, queue, parseTile, signal, extension, body] = matches[0];
    fs.writeFileSync(built, source.replace(match, `${tile}.internal.loadingState = 3, this.__ltdsLoadingBudget?.bodyReady(${tile}, ${body}), ${queue}.add(${tile}, (${parseTile}) => ${signal}.aborted ? Promise.resolve() : ${extension} === "json" && ${body}.root`));
    count++;
  }
  if (count !== 1) throw new Error('loading body hook: expected exactly one built renderer');
}

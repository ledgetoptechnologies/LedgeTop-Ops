import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASIS_THREE_VERSION = '0.185.1';
export const BASIS_UPSTREAM_SHA256 = Object.freeze({
  'basis_transcoder.js': '8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
  'basis_transcoder.wasm': '6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a',
});

// Three r185 ships Emscripten's dynamic Embind invokers. A blob worker inherits
// our document CSP: wasm-unsafe-eval permits WASM, NOT new Function/eval.
// Mirror DYNAMIC_EXECUTION=0's plain-closure strategy without changing the pinned
// decoder WASM or granting unsafe-eval. These are only JS/WASM argument bridges;
// the texture decode algorithm and bytes remain the upstream binary's.
// References: emscripten.org/docs/tools_reference/settings_reference.html#dynamic-execution
// and github.com/mrdoob/three.js/issues/34389. Upstream upgrades MUST be reviewed,
// re-hashed and re-tested, not silently matched by a broad replacement regex.
const invoker = String.raw`function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
  if(argTypes.length<2)throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");
  var isMethod=argTypes[1]!==null&&classType!==null;
  var needsStack=usesDestructorStack(argTypes);
  var returns=argTypes[0].name!=="void";
  var count=argTypes.length-2;
  return createNamedFunction(humanName,function(...args){
    if(args.length!==count)throwBindingError('function '+humanName+' called with '+args.length+' arguments, expected '+count);
    // Per-call arrays preserve reentrancy if a bound function invokes JS.
    var destructors=needsStack?[]:null;
    var wired=[cppTargetFunc];
    if(isMethod)wired.push(argTypes[1].toWireType(destructors,this));
    for(var i=0;i<count;i++)wired.push(argTypes[i+2].toWireType(destructors,args[i]));
    var result=cppInvokerFunc(...wired);
    if(needsStack){runDestructors(destructors);}else{
      for(var i=isMethod?1:2;i<argTypes.length;i++){
        if(argTypes[i].destructorFunction!==null)argTypes[i].destructorFunction(wired[isMethod?i:i-1]);
      }
    }
    if(returns)return argTypes[0].fromWireType(result);
  });
}`;

const methodCaller = String.raw`var __emval_get_method_caller=(argCount,argTypes,kind)=>{
  var types=emval_lookupTypes(argCount,argTypes);
  var retType=types.shift();
  var call=function(obj,func,destructorsRef,args){
    var values=[];
    var offset=0;
    for(var type of types){values.push(type.readValueFromPointer(args+offset));offset+=type.argPackAdvance;}
    var result=kind===1?Reflect.construct(func,values):func.apply(obj,values);
    if(!retType.isVoid)return emval_returnValue(retType,destructorsRef,result);
  };
  return emval_addMethodCaller(createNamedFunction('methodCaller<('+types.map(t=>t.name).join(', ')+') => '+retType.name+'>',call));
};`;

function replaceSection(source, start, end, replacement) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0 || source.indexOf(start, first + start.length) !== -1) {
    throw new Error('Pinned Basis CSP patch boundary changed; review the transcoder before upgrading');
  }
  return source.slice(0, first) + replacement + source.slice(last);
}

export function patchBasisTranscoder(source, threeVersion = BASIS_THREE_VERSION) {
  if (threeVersion !== BASIS_THREE_VERSION
    || createHash('sha256').update(source).digest('hex') !== BASIS_UPSTREAM_SHA256['basis_transcoder.js']) {
    throw new Error('Pinned Basis CSP patch source changed; review the transcoder before upgrading');
  }
  let patched = replaceSection(String(source), 'function newFunc(', 'var __embind_register_class_constructor=', invoker);
  patched = replaceSection(patched, 'var __emval_get_method_caller=', 'var __emval_get_module_property=', methodCaller);
  patched = replaceSection(patched, 'var emval_get_global=', 'var __emval_get_global=', 'var emval_get_global=()=>globalThis;');
  if (/\bnewFunc\b|\bnew\s+Function\b|\beval\s*\(|return Function/.test(patched)) {
    throw new Error('Pinned Basis CSP patch left a dynamic-code path');
  }
  return '// LTDS: pinned Basis CSP closure bridges, revision 1; decoder WASM unchanged.\n' + patched;
}

export function installBasisTranscoder(installRoot = root) {
  const source = path.join(installRoot, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
  const destination = path.join(installRoot, 'public', 'basis');
  const threeVersion = JSON.parse(fs.readFileSync(path.join(installRoot, 'node_modules', 'three', 'package.json'), 'utf8')).version;
  const assets = {};
  for (const [name, expected] of Object.entries(BASIS_UPSTREAM_SHA256)) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) throw new Error(`Pinned Three.js Basis asset is missing: ${from}`);
    const bytes = fs.readFileSync(from);
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error(`Pinned Three.js Basis asset changed: ${name}`);
    }
    assets[name] = bytes;
  }
  assets['basis_transcoder.js'] = patchBasisTranscoder(assets['basis_transcoder.js'], threeVersion);
  fs.mkdirSync(destination, { recursive: true });
  for (const [name, bytes] of Object.entries(assets)) fs.writeFileSync(path.join(destination, name), bytes);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installBasisTranscoder();
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createTaskOptionsModel, parseTaskOption, taskOptionDomain, taskOptionRestriction, mountTaskOptions } from '../workspace-task-options.mjs';
const specs = [{name:'dtm',type:'bool',value:false},{name:'count',type:'int',value:5,domain:{min:0,max:10}},{name:'resolution',type:'float',value:1},{name:'quality',type:'string',value:'high',domain:'["high","low"]'},{name:'label',type:'string',value:''}];
const provider = {id:'one',capabilityFingerprint:'version1',capabilities:{options:specs}};
const { NodeOdmProvider } = createRequire(import.meta.url)('../server/nodeOdmProvider.js');
// Captured read-only from the actual ODM 3.5.6 worker /options response.
const odmChoiceSpecs = [
  {name:'end-with',type:'enum',value:'odm_postprocess',domain:['dataset','split','merge','opensfm','openmvs','odm_filterpoints','odm_meshing','mvs_texturing','odm_georeferencing','odm_dem','odm_orthophoto','odm_report','odm_postprocess'],help:'End processing at this stage. Can be one of: %(choices)s. Default: %(default)s'},
  {name:'min-num-features',type:'int',value:'10000',domain:'integer',help:'Minimum number of features to extract per image.'},
  {name:'feature-quality',type:'enum',value:'high',domain:['ultra','high','medium','low','lowest'],help:'Set feature extraction quality.'},
  {name:'camera-lens',type:'enum',value:'auto',domain:['auto','perspective','brown','fisheye','fisheye_opencv','spherical','equirectangular','dual'],help:'Set a camera projection type.'},
];
test('typed overrides preserve false and zero, omit defaults and clear back to inherited preset values',()=>{
  const model=createTaskOptionsModel({provider,presetOptions:{dtm:true,count:7}});
  assert.deepEqual(model.getOptions(),{});assert.equal(model.entries()[0].inherited,true);
  model.setOverride('dtm','false');model.setOverride('count','0');model.setOverride('resolution','0');
  assert.deepEqual(model.getOptions(),{dtm:false,count:0,resolution:0});
  model.setOverride('dtm',undefined);assert.deepEqual(model.getOptions(),{count:0,resolution:0});assert.equal(model.entries()[0].inherited,true);
});
test('validation rejects malformed numeric, enum and unsupported settings instead of coercing',()=>{
  for(const value of ['', 'NaN','Infinity','1.2','11',true])assert.throws(()=>parseTaskOption(specs[1],value));
  assert.throws(()=>parseTaskOption(specs[0],'yes'));assert.throws(()=>parseTaskOption(specs[3],'other'));
  assert.throws(()=>parseTaskOption(specs[4],'x'.repeat(4001)));
  assert.deepEqual(taskOptionDomain({domain:'positive integer'}),{min:0,minExclusive:true});
  const model=createTaskOptionsModel({provider});model.setOverride('count','invalid');assert.equal(model.validate().valid,false);assert.throws(()=>model.getOptions());
  assert.throws(()=>model.setOverride('unknown',2));
});
test('provider/preset changes clear stale overrides while unchanged refresh preserves them',()=>{
  const model=createTaskOptionsModel({provider,presetOptions:{dtm:true}});model.setOverride('dtm',false);
  assert.equal(model.update({provider:{...provider},presetOptions:{dtm:true}}),false);assert.deepEqual(model.getOptions(),{dtm:false});
  assert.equal(model.update({provider:{...provider,capabilityFingerprint:'version2'},presetOptions:{dtm:true}}),true);assert.deepEqual(model.getOptions(),{});
  model.setOverride('count',0);model.update({provider,presetOptions:{count:3}});assert.deepEqual(model.getOptions(),{});
});
test('file/path inputs and required outputs cannot be edited as arbitrary strings or disabled',()=>{
  for(const name of ['align','cameras','boundary','gcp','geo','pc-ept','gltf','3d-tiles'])assert.ok(taskOptionRestriction({name,type:'string'}));
  assert.ok(taskOptionRestriction({name:'custom-file',type:'string',help:'Path to an input file'}));
  const model=createTaskOptionsModel({provider:{capabilities:{options:[{name:'gltf',type:'bool',value:false},{name:'align',type:'string'}]}}});
  assert.equal(model.entries()[0].inherited,true);assert.throws(()=>model.setOverride('gltf',false));assert.throws(()=>model.setOverride('align','/etc/source'));
});
class Element {
  constructor(tag,ownerDocument){this.tag=tag;this.ownerDocument=ownerDocument;this.children=[];this.listeners={};this.value='';}
  append(child){this.children.push(child);}setAttribute(name,value){this[name]=value;}addEventListener(name,fn){this.listeners[name]=fn;}replaceChildren(){this.children=[];}remove(){this.removed=true;}
}
test('real ODM enum schema remains editable through the adapter in task and preset contexts',async()=>{
  const info={version:'1.5.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:0,maxImages:null,totalMemory:99999999999,availableMemory:99999999999,cpuCores:99999999999};
  const adapter=new NodeOdmProvider({endpoint:'http://cluster.example.test',fetchImpl:async url=>new Response(JSON.stringify(String(url).includes('/info')?info:odmChoiceSpecs),{headers:{'content-type':'application/json'}})});
  const {capabilities,fingerprint}=await adapter.capabilities();
  assert.deepEqual(capabilities.options.map(spec=>spec.name),odmChoiceSpecs.map(spec=>spec.name));
  assert.equal(capabilities.options[0].type,'enum');
  assert.equal(capabilities.options[1].value,10000);
  for(const preset of [false,true]){
    const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);
    const editor=mountTaskOptions({container,provider:{id:'cluster',capabilityFingerprint:fingerprint,capabilities},presetOptions:preset?{'feature-quality':'ultra'}:{},...(preset?{title:'Preset options',modifiedLabel:'Modified preset value'}:{})});
    const list=container.children[0].children[3],stage=list.children[0].children[3],quality=list.children[2].children[3],lens=list.children[3].children[3];
    for(const control of [stage,quality,lens]){assert.equal(control.tag,'select');assert.equal(control.disabled,false);}
    assert.equal(stage.value,'odm_postprocess');assert.equal(stage.children.length,13);
    assert.equal(quality.value,preset?'ultra':'high');assert.equal(lens.value,'auto');
    stage.value='odm_orthophoto';stage.listeners.change();quality.value='medium';quality.listeners.input();lens.value='brown';lens.listeners.change();
    assert.deepEqual(editor.getOptions(),{'end-with':'odm_orthophoto','feature-quality':'medium','camera-lens':'brown'});
    list.children[2].children[2].listeners.click();assert.equal(quality.value,preset?'ultra':'high');
    quality.value='not-a-node-choice';quality.listeners.change();assert.equal(editor.validate().valid,false);assert.throws(()=>editor.getOptions(),/supported values/);
    editor.dispose();
  }
});

test('enum support requires bounded string choices and does not open file inputs or unknown types',()=>{
  const valid={name:'quality',type:'enum',domain:['high','low']};
  assert.equal(taskOptionRestriction(valid),null);assert.equal(parseTaskOption(valid,'low'),'low');
  assert.throws(()=>parseTaskOption(valid,'other'));assert.throws(()=>parseTaskOption(valid,0));
  for(const domain of [undefined,[],['ok',1],['x'.repeat(4001)],Array(1001).fill('ok'),{min:0},'not-json'])assert.ok(taskOptionRestriction({...valid,domain}));
  assert.ok(taskOptionRestriction({...valid,type:'mystery'}));
  assert.ok(taskOptionRestriction({...valid,name:'boundary'}));
  assert.ok(taskOptionRestriction({...valid,help:'Path to an input file'}));
});

test('ODM enum capability refresh retains incompatible draft until reset to the new node default',()=>{
  const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);
  const original={id:'cluster',capabilityFingerprint:'original',capabilities:{options:[odmChoiceSpecs[2]]}};
  const editor=mountTaskOptions({container,provider:original}),list=container.children[0].children[3];
  let control=list.children[0].children[3];control.value='ultra';control.listeners.change();
  editor.update({provider:{...original,capabilityFingerprint:'refreshed',capabilities:{options:[{...odmChoiceSpecs[2],value:'medium',domain:['medium','low']}]}},preserveOverrides:true});
  control=list.children[0].children[3];assert.equal(control.disabled,false);assert.equal(control.value,'ultra');assert.match(control.children[0].textContent,/no longer supported/);
  assert.equal(editor.validate().valid,false);assert.throws(()=>editor.getOptions(),/supported values/);
  list.children[0].children[2].listeners.click();assert.equal(control.value,'medium');assert.deepEqual(editor.getOptions(),{});
  control.value='low';control.listeners.change();assert.deepEqual(editor.getOptions(),{'feature-quality':'low'});
});
test('mounted editor directly edits effective values, resets, searches and preserves drafts when disabled',()=>{
  const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);
  const editor=mountTaskOptions({container,provider,presetOptions:{count:7}}),root=container.children[0],search=root.children[1],list=root.children[3];
  const row=list.children[0],reset=row.children[2],control=row.children[3];assert.equal(control.disabled,false);assert.equal(control.type,'checkbox');assert.equal(reset.disabled,true);
  control.checked=true;control.listeners.change();assert.deepEqual(editor.getOptions(),{dtm:true});assert.equal(reset.disabled,false);
  reset.listeners.click();assert.deepEqual(editor.getOptions(),{});assert.equal(control.checked,false);assert.equal(reset.disabled,true);
  const count=list.children[1].children[3];assert.equal(count.value,'7');count.value='0';count.listeners.input();assert.deepEqual(editor.getOptions(),{count:0});
  search.value='quality';search.listeners.input();assert.equal(row.hidden,true);assert.equal(list.children[3].hidden,false);
  editor.update({provider,presetOptions:{count:7}});assert.deepEqual(editor.getOptions(),{count:0});
  editor.setDisabled(true);assert.equal(list.children[0].children[2].disabled,true);assert.equal(list.children[0].children[3].disabled,true);
  editor.setDisabled(false);assert.equal(list.children[0].children[2].disabled,true);assert.equal(list.children[0].children[3].disabled,false);assert.equal(list.children[1].children[3].disabled,false);assert.equal(list.children[1].children[3].value,'0');
  list.children[1].children[3].value='7';list.children[1].children[3].listeners.input();assert.deepEqual(editor.getOptions(),{});
  editor.dispose();assert.equal(root.removed,true);
});

test('known descriptive numeric domains are validated without executing arbitrary domain text',()=>{
  for(const domain of ['positive integer','positive float','float > 0.0'])assert.throws(()=>parseTaskOption({name:'numeric',type:'float',domain},0));
  assert.equal(parseTaskOption({name:'numeric',type:'float',domain:'non-negative float'},0),0);
  for(const value of [-1,11])assert.throws(()=>parseTaskOption({name:'numeric',type:'float',domain:'0 <= x <= 10'},value));
  assert.equal(parseTaskOption({name:'numeric',type:'float',domain:'0 <= x <= 10'},10),10);
  assert.equal(taskOptionDomain({domain:'process.exit()'}),null);
});
test('explicit capability refresh preserves valid drafts and visibly retains removed or incompatible changes',()=>{
  const model=createTaskOptionsModel({provider});model.setOverride('count','8');model.setOverride('quality','low');
  const changed={...provider,capabilityFingerprint:'changed',capabilities:{options:[{name:'count',type:'int',value:5,domain:{max:6}}]}};
  model.update({provider:changed,preserveOverrides:true});
  assert.equal(model.entries().find(item=>item.spec.name==='count').value,'8');
  const missing=model.entries().find(item=>item.spec.name==='quality');assert.equal(missing.value,'low');assert.equal(missing.missing,true);
  assert.equal(model.validate().errors.length,2);assert.throws(()=>model.getOptions(),/quality/);
  model.setOverride('count',4);model.setOverride('quality',undefined);assert.deepEqual(model.getOptions(),{count:4});
});
test('refreshed select retains unsupported draft visibly and removed settings require explicit removal',()=>{
  const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);
  const editor=mountTaskOptions({container,provider}),list=container.children[0].children[3];
  const quality=list.children[3].children[3];quality.value='low';quality.listeners.input();
  editor.update({provider:{...provider,capabilityFingerprint:'enum-change',capabilities:{options:[{name:'quality',type:'string',value:'high',domain:['high']}]}},preserveOverrides:true});
  assert.equal(list.children[0].children[3].value,'low');assert.match(list.children[0].children[3].children[0].textContent,/no longer supported/);
  editor.update({provider:{...provider,capabilityFingerprint:'removed',capabilities:{options:[]}},preserveOverrides:true});
  assert.equal(list.children[0].children[3].value,'low');assert.equal(list.children[0].children[3].disabled,true);assert.equal(list.children[0].children[2].disabled,false);
  assert.equal(editor.validate().valid,false);list.children[0].children[2].listeners.click();assert.deepEqual(editor.getOptions(),{});
});

test('preset context labels are configurable and restricted settings cannot be changed by events',()=>{
  const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);
  const editor=mountTaskOptions({container,provider:{capabilities:{options:[specs[1],{name:'gltf',type:'bool',value:false}]}},title:'Preset options',helpText:'Save explicitly.',modifiedLabel:'Modified preset value'});
  const root=container.children[0],list=root.children[3];assert.equal(root.children[0].textContent,'Preset options');assert.equal(root.children[2].textContent,'Save explicitly.');
  const count=list.children[0].children[3];count.value='8';count.listeners.input();assert.equal(list.children[0].children[4].textContent,'Modified preset value');
  const required=list.children[1].children[3];assert.equal(required.checked,true);assert.equal(required.disabled,true);required.checked=false;required.listeners.change();assert.deepEqual(editor.getOptions(),{count:8});
  editor.setDisabled(true);const disabled=list.children[0].children[3];disabled.value='2';disabled.listeners.input();assert.deepEqual(editor.getOptions(),{count:8});
});

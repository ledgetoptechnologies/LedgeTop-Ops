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
  constructor(tag,ownerDocument){this.tag=tag;this.ownerDocument=ownerDocument;this.children=[];this.listeners={};this.value='';this.attrs={};this.classes=new Set();}
  append(...children){this.children.push(...children);}setAttribute(name,value){this.attrs[name]=String(value);}getAttribute(name){return this.attrs[name]??null;}
  addEventListener(name,fn){this.listeners[name]=fn;}replaceChildren(){this.children=[];}remove(){this.removed=true;}
  get classList(){const self=this;return{toggle(name,on){if(on)self.classes.add(name);else self.classes.delete(name);}};}
  all(){return this.children.flatMap(child=>[child,...(child.all?child.all():[])]);}
  find(attr,value){return this.all().find(element=>element.attrs&&attr in element.attrs&&(value===undefined||element.attrs[attr]===value));}
}
function mount(options){const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);const editor=mountTaskOptions({container,...options});return{container,editor,root:container.children[0]};}
const row=(container,name)=>container.find('data-option',name);
const control=(container,name)=>row(container,name).find('data-option-control');
const reset=(container,name)=>row(container,name).find('data-option-reset');
const search=container=>container.find('data-option-search');
const changedOnly=container=>container.find('data-show-changed');
test('real ODM enum schema remains editable through the adapter in task and preset contexts',async()=>{
  const info={version:'1.5.3',engine:'odm',engineVersion:'3.5.6',taskQueueCount:0,maxImages:null,totalMemory:99999999999,availableMemory:99999999999,cpuCores:99999999999};
  const adapter=new NodeOdmProvider({endpoint:'http://cluster.example.test',fetchImpl:async url=>new Response(JSON.stringify(String(url).includes('/info')?info:odmChoiceSpecs),{headers:{'content-type':'application/json'}})});
  const {capabilities,fingerprint}=await adapter.capabilities();
  assert.deepEqual(capabilities.options.map(spec=>spec.name),odmChoiceSpecs.map(spec=>spec.name));
  assert.equal(capabilities.options[0].type,'enum');
  assert.equal(capabilities.options[1].value,10000);
  for(const preset of [false,true]){
    const {container,editor}=mount({provider:{id:'cluster',capabilityFingerprint:fingerprint,capabilities},presetOptions:preset?{'feature-quality':'ultra'}:{},...(preset?{title:'Preset options'}:{})});
    const stage=control(container,'end-with'),quality=control(container,'feature-quality'),lens=control(container,'camera-lens');
    for(const item of [stage,quality,lens]){assert.equal(item.tag,'select');assert.equal(item.disabled,false);}
    assert.equal(stage.value,'odm_postprocess');assert.equal(stage.children.length,13);
    assert.equal(quality.value,preset?'ultra':'high');assert.equal(lens.value,'auto');
    stage.value='odm_orthophoto';stage.listeners.change();quality.value='medium';quality.listeners.input();lens.value='brown';lens.listeners.change();
    assert.deepEqual(editor.getOptions(),{'end-with':'odm_orthophoto','feature-quality':'medium','camera-lens':'brown'});
    reset(container,'feature-quality').listeners.click();assert.equal(quality.value,preset?'ultra':'high');
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
  const original={id:'cluster',capabilityFingerprint:'original',capabilities:{options:[odmChoiceSpecs[2]]}};
  const {container,editor}=mount({provider:original});
  let item=control(container,'feature-quality');item.value='ultra';item.listeners.change();
  editor.update({provider:{...original,capabilityFingerprint:'refreshed',capabilities:{options:[{...odmChoiceSpecs[2],value:'medium',domain:['medium','low']}]}},preserveOverrides:true});
  item=control(container,'feature-quality');assert.equal(item.disabled,false);assert.equal(item.value,'ultra');assert.match(item.children[0].textContent,/no longer supported/);
  assert.equal(editor.validate().valid,false);assert.throws(()=>editor.getOptions(),/supported values/);
  reset(container,'feature-quality').listeners.click();assert.equal(item.value,'medium');assert.deepEqual(editor.getOptions(),{});
  item.value='low';item.listeners.change();assert.deepEqual(editor.getOptions(),{'feature-quality':'low'});
});
test('mounted editor directly edits effective values, resets, searches and preserves drafts when disabled',()=>{
  const {container,editor,root}=mount({provider,presetOptions:{count:7}});
  const dtm=control(container,'dtm'),dtmReset=reset(container,'dtm');assert.equal(dtm.disabled,false);assert.equal(dtm.type,'checkbox');assert.equal(dtmReset.disabled,true);assert.equal(dtmReset.hidden,true);
  dtm.checked=true;dtm.listeners.change();assert.deepEqual(editor.getOptions(),{dtm:true});assert.equal(dtmReset.disabled,false);assert.equal(dtmReset.hidden,false);
  dtmReset.listeners.click();assert.deepEqual(editor.getOptions(),{});assert.equal(dtm.checked,false);assert.equal(dtmReset.hidden,true);
  const count=control(container,'count');assert.equal(count.value,'7');count.value='0';count.listeners.input();assert.deepEqual(editor.getOptions(),{count:0});
  search(container).value='quality';search(container).listeners.input();assert.equal(row(container,'dtm').hidden,true);assert.equal(row(container,'quality').hidden,false);
  editor.update({provider,presetOptions:{count:7}});assert.deepEqual(editor.getOptions(),{count:0});
  editor.setDisabled(true);assert.equal(reset(container,'dtm').disabled,true);assert.equal(control(container,'dtm').disabled,true);
  editor.setDisabled(false);assert.equal(reset(container,'dtm').disabled,true);assert.equal(control(container,'dtm').disabled,false);assert.equal(control(container,'count').disabled,false);assert.equal(control(container,'count').value,'0');
  control(container,'count').value='7';control(container,'count').listeners.input();assert.deepEqual(editor.getOptions(),{});
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
  const {container,editor}=mount({provider});
  const quality=control(container,'quality');quality.value='low';quality.listeners.input();
  editor.update({provider:{...provider,capabilityFingerprint:'enum-change',capabilities:{options:[{name:'quality',type:'string',value:'high',domain:['high']}]}},preserveOverrides:true});
  assert.equal(control(container,'quality').value,'low');assert.match(control(container,'quality').children[0].textContent,/no longer supported/);
  editor.update({provider:{...provider,capabilityFingerprint:'removed',capabilities:{options:[]}},preserveOverrides:true});
  assert.equal(control(container,'quality').value,'low');assert.equal(control(container,'quality').disabled,true);assert.equal(reset(container,'quality').disabled,false);assert.equal(reset(container,'quality').hidden,false);
  assert.equal(editor.validate().valid,false);reset(container,'quality').listeners.click();assert.deepEqual(editor.getOptions(),{});
});

test('preset context title is configurable and restricted settings cannot be changed by events',()=>{
  const {container,editor,root}=mount({provider:{capabilities:{options:[specs[1],{name:'gltf',type:'bool',value:false}]}},title:'Preset options'});
  assert.equal(root.children[0].textContent,'Preset options');
  const count=control(container,'count');count.value='8';count.listeners.input();assert.equal(row(container,'count').classes.has('is-changed'),true);
  const required=control(container,'gltf');assert.equal(required.checked,true);assert.equal(required.disabled,true);required.checked=false;required.listeners.change();assert.deepEqual(editor.getOptions(),{count:8});
  editor.setDisabled(true);const disabled=control(container,'count');disabled.value='2';disabled.listeners.input();assert.deepEqual(editor.getOptions(),{count:8});
});

test('every option has a keyboard-focusable info button described by a tooltip, with no inline description',()=>{
  const {container}=mount({provider:{capabilities:{options:[...specs,odmChoiceSpecs[0]]}}});
  for(const name of ['dtm','count','end-with']){
    const item=row(container,name),info=item.find('data-option-info'),tipId=info.attrs['aria-describedby'],tip=item.all().find(element=>element.id===tipId);
    assert.equal(info.tag,'button');assert.equal(info.type,'button');assert.equal(info.attrs['aria-label'],`About ${name}`);assert.notEqual(info.tabIndex,-1);
    assert.ok(tip,'tooltip element exists');assert.equal(tip.attrs.role,'tooltip');
    assert.ok(control(container,name).attrs['aria-describedby'].split(' ').includes(tipId),'control is described by the tooltip too');
    assert.equal(item.all().filter(element=>element.className==='form-note').length,0,'no inline description paragraphs');
  }
  const stageTip=row(container,'end-with').all().find(element=>element.attrs.role==='tooltip');
  assert.match(stageTip.textContent,/Can be one of: dataset, split/);assert.doesNotMatch(stageTip.textContent,/%\(/);
});

test('booleans render as Enable checkboxes, numbers as number inputs, enums as selects, JSON as text plus file loader',async()=>{
  const json={name:'boundary',type:'json',value:'',domain:'json',help:'GeoJSON polygon limiting the area of the reconstruction. Can be specified either as path to a GeoJSON file or as a JSON string.'};
  const {container,editor}=mount({provider:{capabilities:{options:[specs[0],{name:'crop',type:'float',value:3,domain:'positive float'},odmChoiceSpecs[2],json]}}});
  const dtm=control(container,'dtm');assert.equal(dtm.type,'checkbox');assert.ok(row(container,'dtm').all().some(element=>element.textContent==='Enable'));
  const crop=control(container,'crop');assert.equal(crop.tag,'input');assert.equal(crop.type,'number');assert.equal(crop.step,'any');
  assert.match(row(container,'crop').all().find(element=>element.className==='task-option-type').textContent,/\(positive float\)/);
  assert.equal(control(container,'feature-quality').tag,'select');
  const boundary=control(container,'boundary');assert.equal(boundary.type,'text');assert.equal(boundary.disabled,false);
  assert.match(row(container,'boundary').all().find(element=>element.className==='task-option-type').textContent,/\(json\)/);
  const load=row(container,'boundary').find('data-option-load'),file=row(container,'boundary').all().find(element=>element.type==='file');
  assert.equal(load.tag,'button');assert.equal(file.hidden,true);let clicked=0;file.click=()=>{clicked++;};load.listeners.click();assert.equal(clicked,1);
  const geojson='{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}';
  file.files=[{size:geojson.length,text:async()=>geojson}];await file.listeners.change();assert.deepEqual(editor.getOptions(),{boundary:geojson});
  boundary.value='{not json';boundary.listeners.input();assert.equal(editor.validate().valid,false);assert.match(row(container,'boundary').find('data-option-error').textContent,/valid JSON/);
  boundary.value='';boundary.listeners.input();assert.deepEqual(editor.getOptions(),{});
  file.files=[{size:5000,text:async()=>'x'}];await file.listeners.change();assert.match(row(container,'boundary').find('data-option-error').textContent,/4,000/);
  assert.equal(taskOptionRestriction({name:'boundary',type:'string'})!==null,true,'path-style boundary strings stay restricted');
});

test('filter matches option names and show-only-changed hides untouched options',()=>{
  const {container}=mount({provider});
  search(container).value='RES';search(container).listeners.input();
  assert.deepEqual(['dtm','count','resolution','quality','label'].filter(name=>!row(container,name).hidden),['resolution']);
  search(container).value='';search(container).listeners.input();
  const count=control(container,'count');count.value='3';count.listeners.input();
  changedOnly(container).checked=true;changedOnly(container).listeners.change();
  assert.deepEqual(['dtm','count','resolution','quality','label'].filter(name=>!row(container,name).hidden),['count']);
  reset(container,'count').listeners.click();assert.equal(row(container,'count').hidden,true,'a reset option leaves the changed-only list');
  changedOnly(container).checked=false;changedOnly(container).listeners.change();assert.equal(row(container,'dtm').hidden,false);
});

test('per-option reset appears only when changed and returns the default',()=>{
  const {container,editor}=mount({provider,presetOptions:{resolution:2}});
  const resolution=control(container,'resolution'),button=reset(container,'resolution');
  assert.equal(button.hidden,true);assert.match(button.attrs['aria-label'],/Reset resolution to preset/);
  resolution.value='5';resolution.listeners.input();assert.equal(button.hidden,false);assert.deepEqual(editor.getOptions(),{resolution:5});
  button.listeners.click();assert.equal(resolution.value,'2');assert.equal(button.hidden,true);assert.deepEqual(editor.getOptions(),{});
  resolution.value='2';resolution.listeners.input();assert.equal(button.hidden,true,'typing the default back is not a change');
});

test('programmatic boundary value is applied only for supported JSON options',()=>{
  const {editor}=mount({provider:{capabilities:{options:[{name:'boundary',type:'json',value:''},specs[0]]}}});
  assert.equal(editor.supports('boundary','json'),true);assert.equal(editor.supports('dtm','json'),false);
  editor.setValue('boundary','{"type":"FeatureCollection","features":[]}');assert.deepEqual(editor.getOptions(),{boundary:'{"type":"FeatureCollection","features":[]}'});
  editor.setValue('boundary',null);assert.deepEqual(editor.getOptions(),{});
});

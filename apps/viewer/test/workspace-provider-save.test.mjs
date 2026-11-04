import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function saveProviderForm('),source.indexOf('\nfunction editProviderModal('));
function make({api,load}){const state={busy:false},messages=[],shell={setAttribute(){},removeAttribute(){}};const save=new Function('state','shell','api','load','toast',`${body};return saveProviderForm`)(state,shell,api,load,(m,bad)=>messages.push({m,bad}));return {save,state,messages}}
const form=()=>({elements:[{disabled:false}],isConnected:true});
test('acknowledged provider save reports refresh failure without implying save failed',async()=>{const ui=form();let writes=0;const h=make({api:async()=>{writes++},load:async()=>{throw Error('offline')}});assert.equal(await h.save(ui,'/provider/credential',{token:'synthetic'},'Provider token stored'),true);assert.equal(writes,1);assert.match(h.messages[0].m,/Provider token stored.*Refresh/);assert.equal(ui.elements[0].disabled,false);assert.equal(h.state.busy,false)});
test('failed provider write retains editable form and never refreshes',async()=>{const ui=form();let loads=0;const h=make({api:async()=>{throw Error('denied')},load:async()=>{loads++}});assert.equal(await h.save(ui,'/provider/credential',{token:'synthetic'},'Provider token stored'),false);assert.equal(loads,0);assert.equal(ui.elements[0].disabled,false);assert.equal(h.messages[0].m,'denied')});

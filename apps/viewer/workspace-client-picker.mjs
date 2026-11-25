// Type-to-filter client picker (ARIA 1.2 combobox with a listbox popup).
// The controller holds all behaviour and is DOM-free so it can be tested
// directly; bindClientPicker connects it to the markup from clientPickerMarkup.
// Choosing a client only fills the form: sharing still needs the review step
// and its Share button.

const esc=value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

export const CLIENT_PICKER_DEBOUNCE_MS=250;
// The Share dialog lists no clients until staff type at least this many characters.
export const CLIENT_PICKER_MIN_QUERY=2;

const clientKind=client=>client?.rootType==='organization'?'Organisation':client?.rootType==='standalone_client'?'Individual client':null;
// "Ledge Top Drone Services Project Alpha" -> "Drone Services".
export const clientBusinessWord=name=>name?String(name).replace(/^Ledge ?Top\s+/i,'').replace(/\s+Project Alpha$/i,'')||String(name):null;
const nameOf=client=>client?.displayName||'Client',fold=text=>String(text).trim().toLocaleLowerCase();
const keyOf=client=>JSON.stringify([client?.sourceId,client?.workspaceId]);
// Different clients that share a name each get one word that tells them apart: the business, else the organisation,
// else the kind. Only when none of those differ, the end of the id. Rows are never merged by name.
export function clientPickerWord(client,all=[]){
  const others=all.filter(item=>fold(nameOf(item))===fold(nameOf(client))&&keyOf(item)!==keyOf(client));
  if(!others.length)return null;
  for(const word of [item=>clientBusinessWord(item?.businessName),item=>item?.organizationName||null,clientKind]){
    const own=word(client);
    if(own&&others.every(item=>word(item)&&fold(word(item))!==fold(own)))return own;
  }
  return [clientBusinessWord(client?.businessName),client?.workspaceId?`ref ${String(client.workspaceId).slice(-6)}`:null].filter(Boolean).join(', ')||null;
}
// Pages whose rows were all withheld by the server's authority checks are skipped, up to this many in a row.
export const CLIENT_PICKER_EMPTY_PAGE_LIMIT=5;

export function createClientPicker({fetchPage,debounceMs=CLIENT_PICKER_DEBOUNCE_MS,setTimer=setTimeout,clearTimer=clearTimeout,
  onChange=()=>{},onSelect=()=>{},initial=null,minQuery=0}={}){
  const state={query:'',items:[],cursor:null,loading:false,loadingMore:false,error:null,open:false,active:-1,selected:null,loaded:false,minQuery};
  const tooShort=text=>text.trim().length<minQuery;
  let sequence=0,timer=null,controller=null,moreController=null;
  if(initial&&Array.isArray(initial.clients)){state.items=initial.clients.slice();state.cursor=initial.clientsNextCursor||null;state.loaded=true;}
  const changed=()=>onChange(state);
  const cancel=()=>{if(timer!==null){clearTimer(timer);timer=null}controller?.abort();moreController?.abort();controller=moreController=null};
  async function run(query){
    cancel();const mine=++sequence,abort=typeof AbortController==='function'?new AbortController():null;controller=abort;
    state.loading=true;state.loadingMore=false;state.error=null;changed();
    try{
      let page=await fetchPage({query,cursor:null,signal:abort?.signal}),skipped=0;
      if(mine!==sequence)return;// A newer search (or close) owns the list now.
      while(!(page?.clients?.length)&&page?.clientsNextCursor&&skipped++<CLIENT_PICKER_EMPTY_PAGE_LIMIT){
        page=await fetchPage({query,cursor:page.clientsNextCursor,signal:abort?.signal});
        if(mine!==sequence)return;
      }
      state.items=Array.isArray(page?.clients)?page.clients.slice():[];state.cursor=page?.clientsNextCursor||null;
      state.active=state.items.length?0:-1;state.loaded=true;
    }catch(error){
      if(mine!==sequence)return;
      state.items=[];state.cursor=null;state.active=-1;state.error=error;
    }finally{if(mine===sequence){state.loading=false;controller=null;changed()}}
  }
  async function more(){
    if(!state.cursor||state.loading||state.loadingMore)return;
    const mine=sequence,cursor=state.cursor,abort=typeof AbortController==='function'?new AbortController():null;moreController=abort;
    state.loadingMore=true;changed();
    try{
      const seen=new Set(state.items.map(item=>JSON.stringify([item.sourceId,item.workspaceId])));
      let next=cursor,added=0,pages=0;
      do{
        const page=await fetchPage({query:state.query,cursor:next,signal:abort?.signal});
        if(mine!==sequence||cursor!==state.cursor)return;
        for(const item of Array.isArray(page?.clients)?page.clients:[]){
          const key=JSON.stringify([item.sourceId,item.workspaceId]);if(!seen.has(key)){seen.add(key);state.items.push(item);added++}
        }
        next=page?.clientsNextCursor||null;
      }while(!added&&next&&++pages<CLIENT_PICKER_EMPTY_PAGE_LIMIT);
      state.cursor=next;
    }catch(error){if(mine===sequence)state.error=error}
    finally{if(mine===sequence){state.loadingMore=false;moreController=null;changed()}}
  }
  const api={
    state,
    input(text){
      state.query=String(text??'');state.open=true;
      if(state.selected){state.selected=null;onSelect(null)}// Editing the text always clears the choice.
      // The old list no longer matches the text: drop it so Enter or a click cannot pick from it.
      const short=tooShort(state.query);
      cancel();sequence++;state.items=[];state.cursor=null;state.active=-1;state.loading=!short;state.loadingMore=false;state.error=null;state.loaded=false;changed();
      if(!short)timer=setTimer(()=>{timer=null;void run(state.query.trim())},debounceMs);
    },
    focus(){state.open=true;if(!state.loaded&&!state.loading&&!tooShort(state.query))return run(state.query.trim());changed()},
    retry(){if(tooShort(state.query)){changed();return Promise.resolve()}return run(state.query.trim())},
    more,
    close(){if(!state.open)return;state.open=false;changed()},
    move(delta){
      if(!state.open){state.open=true}
      if(!state.items.length){changed();return}
      const next=Math.min(state.items.length-1,Math.max(0,(state.active<0?(delta>0?-1:state.items.length):state.active)+delta));
      state.active=next;changed();
      if(next>=state.items.length-3)void more();
    },
    select(index){
      // Only results for the current text can be chosen.
      if(state.loading)return false;
      const client=state.items[index];if(!client)return false;
      state.selected=client;state.active=index;state.open=false;state.query=clientPickerLabel(client,state.items);changed();onSelect(client,state.query);return true;
    },
    key(name){
      if(name==='ArrowDown'){this.move(1);return true}
      if(name==='ArrowUp'){this.move(-1);return true}
      if(name==='Home'&&state.open&&state.items.length){state.active=0;changed();return true}
      if(name==='End'&&state.open&&state.items.length){state.active=state.items.length-1;changed();void more();return true}
      if(name==='Enter'){if(state.open&&state.active>=0)this.select(state.active);return true}// Never submits the share form.
      if(name==='Escape'){if(!state.open)return false;this.close();return true}
      return false;
    },
    dispose(){cancel();sequence++},
  };
  return api;
}

export function clientPickerLabel(client,all=[]){
  const word=clientPickerWord(client,all);
  return `${nameOf(client)}${word?` (${word})`:''}`;
}

export function clientPickerMarkup({id='direct-client-picker',query=''}={}){
  return `<div class="client-picker" data-client-picker>
<label class="sr-only" for="${esc(id)}-input">Client</label>
<input id="${esc(id)}-input" name="clientQuery" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(id)}-list" aria-describedby="${esc(id)}-status" autocomplete="off" spellcheck="false" placeholder="Type a name, business or email" value="${esc(query)}">
<input type="hidden" name="client" value="">
<ul id="${esc(id)}-list" class="client-picker-list" role="listbox" aria-label="Matching clients" hidden data-client-picker-list></ul>
<p id="${esc(id)}-status" class="form-note client-picker-status" role="status" aria-live="polite" data-client-picker-status></p>
</div>`;
}

export function clientPickerOptions(state,{id='direct-client-picker'}={}){
  return state.items.map((client,index)=>{
    const word=clientPickerWord(client,state.items);
    return `<li id="${esc(id)}-option-${index}" class="client-picker-option" role="option" data-index="${index}" aria-selected="${index===state.active}">`
      +`<span class="client-picker-name">${esc(client.displayName||'Client')}</span>`
      +(word?`<small class="client-picker-meta">${esc(word)}</small>`:'')+'</li>';
  }).join('')+(state.loadingMore?'<li class="client-picker-more" role="presentation">Loading more clients…</li>':'');
}

export function clientPickerStatus(state){
  if(state.selected)return `Selected: ${state.query}`;
  if(state.loading)return 'Searching clients…';
  if(state.error)return 'Clients could not be loaded. Keep typing, or press the Down arrow to try again.';
  if(!state.open)return '';
  if(state.minQuery&&state.query.trim().length<state.minQuery)return `Type at least ${state.minQuery} characters to search clients.`;
  if(!state.items.length)return state.query.trim()?`No clients match “${state.query.trim()}”.`:'No connected clients yet.';
  return `${state.items.length}${state.cursor?'+':''} client${state.items.length===1&&!state.cursor?'':'s'} found. Use the arrow keys to choose.`;
}

// Shown only while something is wrong, empty or on its way; the rest of the status is for screen readers.
export const clientPickerStatusShown=state=>!state.selected&&(state.loading||Boolean(state.error)
  ||state.open&&!state.items.length&&state.query.trim().length>=Math.max(1,state.minQuery||0));

export function bindClientPicker(root,{fetchPage,onSelect,initial,id='direct-client-picker',setTimer,clearTimer,minQuery=CLIENT_PICKER_MIN_QUERY}){
  const input=root.querySelector('[role="combobox"]'),list=root.querySelector('[data-client-picker-list]'),
    status=root.querySelector('[data-client-picker-status]'),hidden=root.querySelector('input[name="client"]');
  const render=state=>{
    list.innerHTML=clientPickerOptions(state,{id});
    const open=state.open&&(state.items.length>0||state.loadingMore);
    list.hidden=!open;input.setAttribute('aria-expanded',String(open));
    if(open&&state.active>=0){input.setAttribute('aria-activedescendant',`${id}-option-${state.active}`);
      list.querySelector(`[data-index="${state.active}"]`)?.scrollIntoView?.({block:'nearest'});}
    else input.removeAttribute('aria-activedescendant');
    status.textContent=clientPickerStatus(state);status.classList?.toggle('sr-only',!clientPickerStatusShown(state));
    // A short list has no scrollbar to scroll: keep loading until it fills its box or runs out.
    if(open&&state.cursor&&!state.loading&&!state.loadingMore&&Number.isFinite(list.scrollHeight)&&list.scrollHeight<=list.clientHeight+1)
      setTimeout(()=>void picker.more(),0);
  };
  const picker=createClientPicker({fetchPage,initial,minQuery,onChange:render,...(setTimer?{setTimer}:{}),...(clearTimer?{clearTimer}:{}),
    onSelect:(client,label)=>{hidden.value=client?JSON.stringify([client.sourceId,client.workspaceId]):'';if(client)input.value=label;onSelect?.(client,label)}});
  input.oninput=()=>picker.input(input.value);
  input.onfocus=()=>void picker.focus();
  input.onkeydown=event=>{
    if(event.key==='ArrowDown'&&picker.state.error&&!picker.state.loading){event.preventDefault();void picker.retry();return}
    if(picker.key(event.key)){event.preventDefault();if(event.key==='Escape')event.stopPropagation()}
  };
  input.onblur=()=>setTimeout(()=>{if(root.isConnected&&!root.contains(root.ownerDocument?.activeElement))picker.close()},150);
  // mousedown keeps focus on the input so screen readers stay in the combobox.
  list.onmousedown=event=>event.preventDefault();
  list.onclick=event=>{const option=event.target.closest?.('[role="option"]');if(option)picker.select(Number(option.dataset.index))};
  list.onscroll=()=>{if(list.scrollTop+list.clientHeight>=list.scrollHeight-48)void picker.more()};
  render(picker.state);
  return picker;
}

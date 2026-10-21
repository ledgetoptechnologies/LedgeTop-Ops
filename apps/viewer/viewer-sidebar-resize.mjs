export function sidebarWidth(value, viewport) {
  const maximum = Math.max(240, Math.min(720, viewport - 360));
  return Math.max(240, Math.min(maximum, Number.isFinite(value) ? value : 300));
}

export function installSidebarResize({sidebar, handle, onResize, window: view = window}) {
  let drag = null, frame = null, disposed = false;
  const notify = () => { if (!disposed && frame === null) frame = view.requestAnimationFrame(() => { frame = null; if(!disposed)onResize(); }); };
  const set = value => {
    const width = sidebarWidth(value, view.innerWidth);
    sidebar.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    handle.setAttribute('aria-valuemax', String(sidebarWidth(720, view.innerWidth)));
    notify();
  };
  const start = event => {
    if(disposed || drag || event.button !== 0 || sidebar.classList.contains('collapsed')) return;
    drag = {id:event.pointerId,x:event.clientX,width:sidebar.getBoundingClientRect().width};
    handle.setPointerCapture(event.pointerId); sidebar.classList.add('resizing'); event.preventDefault();
  };
  const finish = () => { const previous=drag;drag=null;sidebar.classList.remove('resizing');if(previous&&handle.hasPointerCapture(previous.id))handle.releasePointerCapture(previous.id);if(previous)notify(); };
  const move = event => { if(disposed)return;if(sidebar.classList.contains('collapsed')){finish();return;}if(drag?.id === event.pointerId) set(drag.width + event.clientX - drag.x); };
  const end = event => { if(drag?.id === event.pointerId) finish(); };
  const key = event => {
    if(disposed || sidebar.classList.contains('collapsed') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault(); const width=sidebar.getBoundingClientRect().width;
    set(event.key==='Home'?240:event.key==='End'?720:width+(event.key==='ArrowRight'?20:-20));
  };
  const resize = () => {if(!disposed)set(parseFloat(sidebar.style.getPropertyValue('--sidebar-width')) || 300);};
  handle.addEventListener('pointerdown',start);handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);handle.addEventListener('lostpointercapture',end);
  handle.addEventListener('keydown',key);view.addEventListener('resize',resize);view.addEventListener('blur',finish);resize();
  return () => {disposed=true;finish();if(frame!==null)view.cancelAnimationFrame(frame);frame=null;handle.removeEventListener('pointerdown',start);handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);handle.removeEventListener('lostpointercapture',end);handle.removeEventListener('keydown',key);view.removeEventListener('resize',resize);view.removeEventListener('blur',finish);};
}

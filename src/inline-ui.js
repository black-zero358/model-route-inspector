/* ISOLATED, per-message UI. Never associates records by position or recency. */
(function (root) {
  'use strict';
  const LABELS={match:'一致',mismatch:'切换',conflict:'冲突',unknown:'待确认'};
  function ms(value) {return typeof value==='number' && Number.isFinite(value) && value>=0 ? (value<1000 ? Math.round(value)+' ms' : (value/1000).toFixed(2)+' s') : 'Null';}
  function messageIds(record) {const ids=Array.isArray(record.assistantMessageIds) ? record.assistantMessageIds : [record.messageId];return Array.from(new Set(ids.filter(id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))).slice(0,32);}
  function inputIds(record) {return Array.from(new Set((record.inputMessageIds || []).filter(id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))).slice(0,32);}
  function bindingInputIds(record){const ids=inputIds(record);return ids.length===1 ? ids : [];}
  function replyControls(turn){const typed=turn.querySelectorAll('[data-talvt-turn-state] > .turn-action-controls');return typed.length ? typed : turn.querySelectorAll('.turn-action-controls');}
  function conversationMatches(record,pathname) {
    const match=/\/c\/([^/]+)/.exec(pathname || '');
    return !match || (typeof record.conversationId==='string' && match[1]===record.conversationId);
  }
  function summary(record) {
    if(record.associationAmbiguous)return {status:'unknown',model:'模型未确认',label:'关联待确认',effort:'',first:'',total:''};
    const actual=record.serverModel || record.resolvedModel || record.messageModel;
    const status=actual && LABELS[record.status] ? record.status : 'unknown';
    const effort=record.thinkingEffort || record.requestedThinkingEffort;
    return {status,model:actual || 'Null',label:LABELS[status],effort:effort ? (record.thinkingEffort ? '思考 ' : '请求思考 ')+String(effort).slice(0,24) : '思考 Null',first:'首 token '+ms(record.firstTokenMs),total:'总耗时 '+ms(record.totalMs)};
  }
  const CSS=`:host{display:block;min-width:0;max-width:100%;margin-inline-start:auto;flex:0 1 auto;color-scheme:light dark}*{box-sizing:border-box}.bar{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px 8px;font:11px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:light-dark(#616876,#aab3c2);max-width:100%;padding:2px 0}.model{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;border-radius:5px;padding:1px 6px;background:light-dark(#f1f3f5,#30343b);color:light-dark(#5c6570,#c3c9d2)}.model.match{background:light-dark(#e5f5eb,#183c2c);color:light-dark(#21613a,#a6e4bd)}.model.mismatch,.model.conflict{background:light-dark(#fdebea,#48272b);color:light-dark(#9a3439,#f4b2b7)}.model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}.state{flex-shrink:0;font-size:10px}.metric{white-space:nowrap;font-variant-numeric:tabular-nums}button{font:inherit;cursor:pointer;appearance:none;border:1px solid light-dark(#dce1e7,#495360);border-radius:5px;padding:1px 5px;color:inherit;background:transparent;flex-shrink:0}button:hover{background:light-dark(#e9edf2,#323e4e)}button:focus-visible{outline:2px solid #5a94d8;outline-offset:2px}.heading{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.heading strong{font-size:15px}.note{font-size:12px;color:light-dark(#657181,#b5bece);margin:9px 0}.tools{padding:0;list-style:none;margin:0}.tool{padding:9px 0;border-top:1px solid light-dark(#edf0f4,#364250);overflow-wrap:anywhere}.tool-meta{font-size:11px;color:light-dark(#657181,#b5bece)}@media(max-width:600px){.bar{font-size:10px;gap:3px 6px}.model-name{max-width:150px}:host{flex-basis:100%}.bar{justify-content:flex-start;padding-block:4px}}`;
  // Resolve authored color pairs to ordinary colors before sending CSS to the browser.
  // light-dark() itself needs Chrome 123; the extension still supports Chrome 111.
  function themeCss(scheme){return CSS.replace(/light-dark\((#[0-9a-f]+),(#[0-9a-f]+)\)/gi,(_pair,light,dark)=>scheme==='dark' ? dark : light);}
  function panelGeometry(anchor,viewport,footerTop,height){
    const left=viewport.left+12,top=viewport.top+12,right=viewport.left+viewport.width-12;
    const bottom=Math.min(viewport.top+viewport.height-12,Number.isFinite(footerTop) ? footerTop-12 : Infinity);
    const maxHeight=Math.max(0,Math.min(360,bottom-top)),width=Math.max(0,Math.min(260,right-left));
    const visible=anchor.right>left && anchor.left<right && anchor.bottom>top && anchor.top<bottom;
    return {left,top,right,bottom,width,maxHeight,visible,flow:viewport.width<=600 || anchor.right+8+width>right,x:anchor.right+8,y:Math.max(top,Math.min(anchor.top,bottom-Math.min(height,maxHeight)))};
  }
  function clippedViewport(viewport,clips){
    let left=viewport.left,top=viewport.top,right=left+viewport.width,bottom=top+viewport.height;
    for(const clip of clips){if(clip.x){left=Math.max(left,clip.left);right=Math.min(right,clip.right);}if(clip.y){top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}}
    return {left,top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)};
  }
  const PANEL_CSS=':host{position:relative}.panel[hidden]{display:none}.panel{position:absolute;inset:auto;margin:0;width:260px;max-width:calc(100vw - 24px);max-height:min(360px,calc(100vh - 24px));border:1px solid #d8dee7;border-radius:8px;background:#fff;color:#222d3a;padding:12px;box-shadow:0 4px 12px #0002;font:12px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow:auto;z-index:auto}.panel .heading strong{font-size:13px}.panel .note{font-size:11px}';
  function createController(options) {
    const doc=options.document,win=options.window;
    const records=new Map(),turnRecords=new Map(),variantRecords=new Map(),pending=new Map(),mounts=new Map(),ambiguousTurns=new Set(),turnPhases=new Map(),displayedComplete=new Map(),historicalRequests=new WeakSet(),unverifiedHistory=new WeakSet(),liveRequests=new Set();
    let observer=null,timer=null,queued=false,active=false,readyPending=false,route=win.location.pathname,sequence=0;
    function theme(){const el=doc.documentElement,classes=(el.getAttribute('class') || '').split(/\s+/),name=el.getAttribute('data-theme');if(classes.includes('dark') || name==='dark')return 'dark';if(classes.includes('light') || name==='light')return 'light';if(typeof win.getComputedStyle==='function'){const scheme=win.getComputedStyle(el).colorScheme;if(scheme==='dark' || scheme==='light')return scheme;}return typeof win.matchMedia==='function' && win.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';}
    function closeMount(mount) {
      if (mount.closePanel)mount.closePanel(false);
      mount.host.remove();
      if(mount.controls.style.flexWrap==='wrap')mount.controls.style.flexWrap=mount.previousWrap || '';
    }
    function build(record,controls,message) {
      const host=doc.createElement('span');host.className='mri-inline-host';host.setAttribute('data-mri','inline');
      host.style.cssText='margin-inline-start:auto;min-width:0;max-width:100%;';
      host.style.colorScheme=theme();
      function sheet(scheme){return themeCss(scheme)+PANEL_CSS+'.model:focus-visible{outline:2px solid #5a94d8;outline-offset:2px}'+(scheme==='dark' ? '.panel{background:#1c2430;color:#edf1f8;border-color:#485365}' : '');}
      const shadow=host.attachShadow({mode:'open'}),style=doc.createElement('style');style.textContent=sheet(host.style.colorScheme);
      const bar=doc.createElement('div');bar.className='bar';bar.setAttribute('aria-label','本回复模型与耗时');
      const s=summary(record),badge=doc.createElement('span');badge.className='model '+s.status;
      const detail=record.associationAmbiguous ? '模型未确认：'+(record.reason || '关联证据不足')+'；此页面无法确认当前回复分支，也无法确认当前回复的工具调用。' : '请求：'+(record.requestedModel || 'Null')+'；Server：'+(record.serverModel || 'Null')+'；Resolved：'+(record.resolvedModel || 'Null')+'；Message：'+(record.messageModel || 'Null')+'；判定：'+s.label+'；'+(record.reason || '')+'；实际模型为客户端可见的响应元数据。';
      badge.title=detail;badge.setAttribute('role','group');badge.setAttribute('tabindex','0');badge.setAttribute('aria-label',detail);
      const name=doc.createElement('span');name.className='model-name';name.textContent=s.model;
      badge.append(name);bar.append(badge);
      [s.effort,s.first,s.total].forEach((text,index)=>{if(!text)return;const el=doc.createElement('span');el.className='metric';el.textContent=text;if(index===0)el.title=record.thinkingEffort ? '响应中的思考强度：'+record.thinkingEffort : record.requestedThinkingEffort ? '仅观察到请求中的思考强度：'+record.requestedThinkingEffort : '思考强度：Null。请求与响应均未观察到思考强度，不能由即时模式推断为无。';if(index===1)el.title='从请求开始到客户端首次收到 assistant 文本或首 token 标记；不是服务端内部生成时刻。'+(record.firstTokenSource ? ' 来源：'+({'assistant.text':'正文文本','assistant.reasoning':'推理文本','marker.reasoning':'推理首 token 标记','marker.user_visible':'可见首 token 标记'}[record.firstTokenSource] || 'Null') : ' 来源：Null。');if(index===2)el.title='请求开始至本地结束观察；'+(record.streamComplete ? '观察到完成标志' : '未观察完成标志')+((record.transportCanceled || record.aborted) ? '；传输已取消' : '')+(record.captureLimited ? '；采集受限' : '');bar.append(el);});
      const panelId='mri-details-'+(++sequence),button=doc.createElement('button');button.type='button';button.textContent='更多';button.title='查看本回复观察到的工具调用';button.setAttribute('aria-label','更多：本回复工具调用');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',panelId);
      if(record.associationAmbiguous){button.disabled=true;button.title='关联证据不足，无法确认当前回复的工具调用';}
      const dialog=doc.createElement('section');dialog.className='panel';dialog.id=panelId;dialog.hidden=true;dialog.setAttribute('role','region');dialog.setAttribute('aria-label','本回复工具调用');
      const heading=doc.createElement('div');heading.className='heading';const title=doc.createElement('strong');title.textContent='本回复工具调用';const close=doc.createElement('button');close.type='button';close.textContent='关闭';heading.append(title,close);dialog.append(heading);
      const note=doc.createElement('p');note.className='note';note.textContent=record.toolEvidence==='observed' ? '以下为本次响应中观察到的工具元数据；列表不代表完整调用链。' : '本次响应中未观察到工具调用元数据，不代表没有调用工具。';dialog.append(note);
      const tools=doc.createElement('ul');tools.className='tools';(record.toolCalls || []).forEach(tool=>{const item=doc.createElement('li');item.className='tool';const label=doc.createElement('div');label.textContent=tool.name;const meta=doc.createElement('div');meta.className='tool-meta';meta.textContent=(typeof tool.count==='number' ? '次数 '+tool.count : '次数 Null')+' · '+({completed:'已完成',in_progress:'运行中',failed:'失败',observed:'已观察',canceled:'已取消'}[tool.status] || '状态 Null')+' · 耗时 '+ms(tool.durationMs);item.append(label,meta);tools.append(item);});dialog.append(tools);
      const privacy=doc.createElement('p');privacy.className='note';privacy.textContent='仅展示工具名称、计数、状态和耗时；缺失字段显示 Null。';dialog.append(privacy);
      let inFlow=false,previousAlign,positionFrame=null;
      function closePanel(focus){dialog.hidden=true;if(positionFrame!==null){win.cancelAnimationFrame(positionFrame);positionFrame=null;}if(inFlow){controls.style.alignItems=previousAlign || '';inFlow=false;}button.setAttribute('aria-expanded','false');doc.removeEventListener('pointerdown',outside,true);doc.removeEventListener('keydown',onKey,true);win.removeEventListener('resize',queuePosition);win.removeEventListener('scroll',queuePosition,true);if(win.visualViewport){win.visualViewport.removeEventListener('resize',queuePosition);win.visualViewport.removeEventListener('scroll',queuePosition);}if(focus && button.isConnected)button.focus();}
      function queuePosition(){if(!dialog.hidden && positionFrame===null)positionFrame=win.requestAnimationFrame(()=>{positionFrame=null;positionPanel(false);});}
      function visibleViewport(){const v=win.visualViewport;return v ? {left:v.offsetLeft,top:v.offsetTop,width:v.width,height:v.height} : {left:0,top:0,width:win.innerWidth,height:win.innerHeight};}
      function panelViewport(){
        const clips=[];if(typeof win.getComputedStyle==='function')for(let el=host.parentElement;el;el=el.parentElement){
          const css=win.getComputedStyle(el),x=/^(auto|scroll|hidden|clip|overlay)$/.test(css.overflowX),y=/^(auto|scroll|hidden|clip|overlay)$/.test(css.overflowY);if(!x && !y)continue;
          const r=el.getBoundingClientRect(),left=r.left+(el.clientLeft || 0),top=r.top+(el.clientTop || 0);
          clips.push({x,y,left,top,right:left+(Number.isFinite(el.clientWidth) ? el.clientWidth : r.right-left),bottom:top+(Number.isFinite(el.clientHeight) ? el.clientHeight : r.bottom-top)});
        }
        return clippedViewport(visibleViewport(),clips);
      }
      function footerBoundary(viewport){
        // The observed footer contains both the composer and its covering background.
        // Fall back to the stable composer surface only when that outer footer is absent.
        for(const selector of ['[data-thread-scroll-footer]','form[data-chatgpt-composer]','[data-composer-body]']){
          const tops=Array.from(doc.querySelectorAll(selector)).map(el=>el.getBoundingClientRect()).filter(r=>r.right>viewport.left && r.left<viewport.left+viewport.width && r.bottom>viewport.top && r.top<viewport.top+viewport.height && r.bottom>r.top).map(r=>r.top);
          if(tops.length)return Math.min(...tops);
        }
        return null;
      }
      function positionPanel(initial){if(dialog.hidden)return;if(!host.isConnected || !button.isConnected){closePanel(false);return;}const anchor=button.getBoundingClientRect(),origin=host.getBoundingClientRect(),viewport=panelViewport(),footerTop=footerBoundary(viewport),geometry=panelGeometry(anchor,viewport,footerTop,dialog.offsetHeight);if(!geometry.visible || geometry.maxHeight<80 || geometry.width<80){closePanel(false);return;}dialog.style.width=geometry.width+'px';dialog.style.maxHeight=geometry.maxHeight+'px';
        // Reserve space whenever the right side is constrained. Normal sibling paint order
        // must never draw later reply controls through an overlapping, same-level panel.
        if(geometry.flow){if(!inFlow){previousAlign=controls.style.alignItems;controls.style.alignItems='flex-start';inFlow=true;}dialog.style.position='static';dialog.style.margin='6px 0 0 auto';dialog.style.maxWidth='100%';dialog.style.left='auto';dialog.style.top='auto';
          let rect=dialog.getBoundingClientRect();const scroller=host.closest('[data-app-action-timeline-scroll]');
          // Opening may reserve space below a fixed composer. Scroll the real conversation
          // container once; subsequent scroll events never fight the user's scroll position.
          if(initial && scroller && typeof scroller.scrollBy==='function' && rect.bottom>geometry.bottom){const amount=Math.min(rect.bottom-geometry.bottom,Math.max(0,anchor.top-geometry.top));if(amount>0)scroller.scrollBy({top:amount,behavior:'auto'});rect=dialog.getBoundingClientRect();}
          const available=Math.min(geometry.maxHeight,geometry.bottom-Math.max(rect.top,geometry.top));if(available<80){closePanel(false);return;}dialog.style.maxHeight=available+'px';return;}
        if(inFlow){controls.style.alignItems=previousAlign || '';inFlow=false;}dialog.style.position='absolute';dialog.style.margin='0';dialog.style.maxWidth='calc(100vw - 24px)';const placed=panelGeometry(anchor,viewport,footerTop,dialog.offsetHeight);dialog.style.left=(placed.x-origin.left)+'px';dialog.style.top=(placed.y-origin.top)+'px';}
      function outside(ev){const path=typeof ev.composedPath==='function' ? ev.composedPath() : [];if(!path.includes(dialog) && !path.includes(button))closePanel(false);}
      function onKey(ev){if(ev.key==='Escape'){ev.preventDefault();closePanel(true);}}
      button.addEventListener('click',()=>{if(!dialog.hidden){closePanel(false);return;}for(const m of mounts.values())if(m.closePanel)m.closePanel(false);dialog.hidden=false;button.setAttribute('aria-expanded','true');positionPanel(true);if(dialog.hidden)return;doc.addEventListener('pointerdown',outside,true);doc.addEventListener('keydown',onKey,true);win.addEventListener('resize',queuePosition);win.addEventListener('scroll',queuePosition,true);if(win.visualViewport){win.visualViewport.addEventListener('resize',queuePosition);win.visualViewport.addEventListener('scroll',queuePosition);}});close.addEventListener('click',()=>closePanel(true));
      const previousWrap=controls.style.flexWrap;controls.style.flexWrap='wrap';
      bar.append(button);shadow.append(style,bar,dialog);controls.append(host);
      return {host,dialog,record,controls,message,previousWrap,style,sheet,closePanel};
    }
    function reconcile() {
      queued=false;if(!active)return;
      const colorScheme=theme();for(const m of mounts.values()){if(m.host.style.colorScheme!==colorScheme){m.host.style.colorScheme=colorScheme;m.style.textContent=m.sheet(colorScheme);}}
      const changed=route!==win.location.pathname;route=win.location.pathname;
      for(const [id,m] of mounts){const staleId=id.startsWith('turn:') ? m.message.getAttribute('data-turn-key')!==id.slice(5) : m.message.getAttribute('data-message-id')!==id;const awaiting=inputIds(m.record).some(input=>pending.has(input));if(changed || staleId || awaiting || !m.host.isConnected || !m.message.isConnected || !m.controls.contains(m.host)){closeMount(m);mounts.delete(id);}}
      const candidates=doc.querySelectorAll('[data-message-author-role="assistant"][data-message-id]');
      const seen=new Set();
      for(const message of candidates){
        const id=message.getAttribute('data-message-id');if(seen.has(id))continue;seen.add(id);
        const record=records.get(id);if(!record || inputIds(record).some(input=>pending.has(input)) || !conversationMatches(record,route))continue;
        const turn=message.closest('[data-testid^="conversation-turn-"],article');
        if(!turn)continue;
        // Multiple IDs can appear in a turn. Only an unambiguous visible reply gets a footer.
        const assistants=turn.querySelectorAll('[data-message-author-role="assistant"][data-message-id]');
        if(assistants.length!==1 || assistants[0]!==message){const stale=mounts.get(id);if(stale){closeMount(stale);mounts.delete(id);}continue;}
        const controlsList=replyControls(turn);if(controlsList.length!==1){const stale=mounts.get(id);if(stale){closeMount(stale);mounts.delete(id);}continue;}
        const controls=controlsList[0];
        const old=mounts.get(id);if(old && old.record===record && old.controls===controls)continue;
        if(old)closeMount(old);mounts.set(id,build(record,controls,message));
      }
      // Current ChatGPT virtualized layout exposes the request's user message ID as turn-key.
      // It cannot identify a regenerated assistant branch; multiple requests stay neutral.
      for(const turn of doc.querySelectorAll('[data-turn-key]')){
        const id=turn.getAttribute('data-turn-key'),key='turn:'+id;
        if(turn.querySelector('[data-message-author-role="assistant"][data-message-id]'))continue;
        const choices=Array.from((turnRecords.get(id) || new Map()).values()).filter(r=>conversationMatches(r,route));
        const variants=[];for(const [parent,group] of variantRecords){if(parent===id || knownAssistantInputs(parent).includes(id)){for(const rec of group.values())if(conversationMatches(rec,route))variants.push(rec);}}
        const old=mounts.get(key);
        const controlsList=replyControls(turn);if(controlsList.length!==1){if(old){closeMount(old);mounts.delete(key);}continue;}
        const phase=controlsList[0].parentElement.getAttribute('data-talvt-turn-state');
        if(phase==='in_progress'){
          if(turnPhases.get(id)==='complete' && displayedComplete.has(id) || variants.length || choices.some(rec=>historicalRequests.has(rec)))ambiguousTurns.add(id);
          turnPhases.set(id,phase);if(old){closeMount(old);mounts.delete(key);}continue;
        }
        if(phase)turnPhases.set(id,phase);
        if(pending.has(id) || choices.length+variants.length===0){if(old){closeMount(old);mounts.delete(key);}continue;}
        const record=choices.length===1 && variants.length===0 && !ambiguousTurns.has(id) && !choices.some(rec=>unverifiedHistory.has(rec)) ? choices[0] : {associationAmbiguous:true,reason:'本输入对应多次生成或旧历史缺少动作证据，无法确认当前回复分支'};
        if(phase==='complete' && !record.associationAmbiguous){displayedComplete.set(id,record.requestId);while(displayedComplete.size>256)displayedComplete.delete(displayedComplete.keys().next().value);}
        const controls=controlsList[0];
        if(old && old.controls===controls && (old.record===record || old.record.associationAmbiguous && record.associationAmbiguous))continue;
        if(old)closeMount(old);mounts.set(key,build(record,controls,turn));
      }
    }
    function schedule(){if(active && !queued){queued=true;win.requestAnimationFrame(reconcile);}}
    function onDocumentReady(){doc.removeEventListener('DOMContentLoaded',onDocumentReady);readyPending=false;start();}
    function start(){if(active)return;if(!doc.documentElement){if(!readyPending){readyPending=true;doc.addEventListener('DOMContentLoaded',onDocumentReady,{once:true});}return;}active=true;observer=new win.MutationObserver(mutations=>{if(mutations.some(m=>!(m.target.nodeType===1 && m.target.closest && m.target.closest('.mri-inline-host'))))schedule();});observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-message-id','data-message-author-role','data-turn-key','data-talvt-turn-state','data-testid','class','data-theme']});timer=win.setInterval(()=>{if(route!==win.location.pathname)schedule();},1000);schedule();}
    function stop(){active=false;if(readyPending){doc.removeEventListener('DOMContentLoaded',onDocumentReady);readyPending=false;}if(observer)observer.disconnect();observer=null;if(timer!==null)win.clearInterval(timer);timer=null;for(const m of mounts.values())closeMount(m);mounts.clear();}
    function variantParent(record){return record.requestAction==='variant' && typeof record.requestedParentMessageId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(record.requestedParentMessageId) ? record.requestedParentMessageId : null;}
    function knownAssistantInputs(parent){const previous=records.get(parent);return previous && Array.isArray(previous.assistantMessageIds) && previous.assistantMessageIds.includes(parent) ? bindingInputIds(previous) : [];}
    function variantInputs(parent){const direct=turnRecords.has(parent) || Array.from(doc.querySelectorAll('[data-turn-key]')).some(turn=>turn.getAttribute('data-turn-key')===parent);return direct ? [parent] : knownAssistantInputs(parent);}
    function accept(record,fromHistory){if(fromHistory){if(!liveRequests.has(record.requestId)){historicalRequests.add(record);if(!['next','variant','continue'].includes(record.requestAction))unverifiedHistory.add(record);}}else{liveRequests.add(record.requestId);historicalRequests.delete(record);unverifiedHistory.delete(record);}while(liveRequests.size>256)liveRequests.delete(liveRequests.values().next().value);for(const id of messageIds(record)){records.delete(id);records.set(id,record);}for(const id of bindingInputIds(record)){let group=turnRecords.get(id);if(!group){group=new Map();turnRecords.set(id,group);}group.set(record.requestId,record);if(group.size>2)group.delete(group.keys().next().value);if(pending.get(id)===record.requestId)pending.delete(id);}const parent=variantParent(record);if(parent){let group=variantRecords.get(parent);if(!group){group=new Map();variantRecords.set(parent,group);}group.set(record.requestId,record);if(group.size>2)group.delete(group.keys().next().value);for(const id of variantInputs(parent)){ambiguousTurns.add(id);if(pending.get(id)===record.requestId)pending.delete(id);}}while(records.size>256)records.delete(records.keys().next().value);while(turnRecords.size>256)turnRecords.delete(turnRecords.keys().next().value);while(variantRecords.size>256)variantRecords.delete(variantRecords.keys().next().value);while(ambiguousTurns.size>256)ambiguousTurns.delete(ambiguousTurns.values().next().value);while(turnPhases.size>256)turnPhases.delete(turnPhases.keys().next().value);for(const [id,m] of mounts){if(id.startsWith('turn:') ? !turnRecords.has(id.slice(5)) && !variantRecords.has(id.slice(5)) && !ambiguousTurns.has(id.slice(5)) : !records.has(id)){closeMount(m);mounts.delete(id);}}schedule();}
    function requestContext(context){for(const id of bindingInputIds(context)){pending.set(id,context.requestId);const previous=turnRecords.get(id);if(previous && Array.from(previous.keys()).some(requestId=>requestId!==context.requestId))ambiguousTurns.add(id);}const parent=variantParent(context);if(parent && (!context.conversationId || conversationMatches(context,win.location.pathname))){for(const id of variantInputs(parent)){pending.set(id,context.requestId);ambiguousTurns.add(id);}}while(pending.size>256)pending.delete(pending.keys().next().value);schedule();}
    win.addEventListener('popstate',schedule);win.addEventListener('pagehide',stop);win.addEventListener('pageshow',start);start();
    return {accept,requestContext,reconcile,destroy(){stop();records.clear();turnRecords.clear();variantRecords.clear();ambiguousTurns.clear();turnPhases.clear();displayedComplete.clear();liveRequests.clear();pending.clear();win.removeEventListener('popstate',schedule);win.removeEventListener('pagehide',stop);win.removeEventListener('pageshow',start);}};
  }
  const api={messageIds,inputIds,bindingInputIds,conversationMatches,summary,ms,themeCss,panelGeometry,clippedViewport,createController};
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  else root.MRIInline=api;
})(typeof globalThis!=='undefined' ? globalThis : this);

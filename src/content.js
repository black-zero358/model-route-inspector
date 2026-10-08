/* ISOLATED bridge. Page messages are untrusted: copy bounded, typed metadata only. */
(function () {
  'use strict';
  const STRINGS = ('requestId endpoint conversationId messageId serverRequestId turnExchangeId turnTraceId requestedModel defaultModel resolvedModel serverModel messageModel modelSlug requestedExperience thinkingEffort autoSwitcherRaceWinner planType planTypeBucket productExperience turnMode turnUseCase warmupState clusterRegion region transport contentType toolName status reason cancelReason timingSource').split(' ');
  const NUMBERS = ('startedAt endedAt timestamp responseStatus serverTtfvt firstByteMs firstDeltaMs responseHeadersMs firstTextMs firstReasoningMs completionMs totalMs reasoningStartTime reasoningEndTime reasoningDurationMs finishedDurationSec searchToolCallCount').split(' ');
  const BOOLS = ('isAutoswitcherEnabled didAutoSwitchToReasoning fastConvo conduitPrewarmed isFirstTurn resumeWithWebsockets toolInvoked isSearch isMultimodal didPromptContainImage conflict aborted streamComplete transportCanceled captureLimited').split(' ');
  const ARRAYS = ['modelSwitcherDeny','searchToolQueryTypes','completionSignals'];
  const FIELDS = new Set(STRINGS.concat(NUMBERS,BOOLS,ARRAYS));
  const STATUS = {match:'一致',mismatch:'切换',unknown:'待确认',conflict:'冲突'};
  const COLORS = {match:'#7ce4ac',mismatch:'#ff9797',unknown:'#efcd75',conflict:'#ffb083'};
  const STATE = {floatingEnabled:true,lastRecord:null,el:null,name:null,sub:null,metrics:null,storage:null,signature:null};
  function own(o,k) { return Object.prototype.hasOwnProperty.call(o,k); }
  function endpoint(value) {
    if (typeof value!=='string' || value.length>2048) return null;
    try { const u=new URL(value,location.origin); return u.origin===location.origin && /^\/backend-api\/(?:(?:f|v\d+(?:\.\d+)*)\/){0,2}(?:conversation(?:\/prepare|\/init)?|stop_conversation)\/?$/.test(u.pathname) ? u.pathname : null; } catch (_) {return null;}
  }
  function safeRecord(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out = {};
    function copy(keys,type) {
      keys.forEach(function(k) {
        if (!own(input,k)) return;
        const v=input[k];
        if (v===null) out[k]=null;
        else if (typeof v===type && (type!=='number' || Number.isFinite(v))) out[k]=type==='string' ? v.slice(0,256) : v;
      });
    }
    copy(STRINGS,'string'); copy(NUMBERS,'number'); copy(BOOLS,'boolean');
    if (own(input,'endpoint')) out.endpoint=endpoint(input.endpoint);
    if (['event_limit','structure_limit','idle_timeout','pre_match_limit'].includes(input.captureLimited)) out.captureLimited=input.captureLimited;
    ARRAYS.forEach(function(k) { if (input[k]===null) out[k]=null; else if (Array.isArray(input[k])) out[k]=input[k].slice(0,32).filter(function(v) {return typeof v==='string';}).map(function(v) {return v.slice(0,128);}); });
    ['fieldStates','fieldSources'].forEach(function(map) {
      out[map]={};
      const m=input[map];
      if (!m || typeof m!=='object' || Array.isArray(m)) return;
      FIELDS.forEach(function(k) {
        if (!own(m,k) || typeof m[k]!=='string') return;
        if (map==='fieldStates' && ['value','null','empty','invalid'].includes(m[k])) out[map][k]=m[k];
        if (map==='fieldSources' && /^[a-zA-Z0-9_.$/\[\]-]{1,256}$/.test(m[k])) out[map][k]=m[k];
      });
    });
    // A bridge message cannot prove origin; this check only rejects malformed envelopes.
    if (!own(STATUS,out.status) || (!out.requestId && !out.requestedModel && !out.resolvedModel && !out.serverModel && !out.messageModel)) return null;
    return out;
  }
  function safeDiag(input) {
    if (!input || typeof input!=='object') return null;
    const out={};
    ['version','fetchCalls','candidates','matched','records','hookInstalled'].forEach(function(k) { const v=input[k]; if (typeof v==='boolean' || typeof v==='number' && Number.isFinite(v)) out[k]=v; });
    // Strip path/query/fragment to avoid exporting unrelated page information.
    if (typeof input.href==='string') { try { out.href=new URL(input.href).origin; } catch (_) {} }
    const strings=['endpoint','method','contentType','transport','judgment','requestedModel','resolvedModel','serverModel','error','parserError'];
    const nums=['status','chunks','events','jsonEvents','startedAt','endedAt'];
    const bools=['matched','hasRequested','hasResolved','hasServerSte','streamComplete','transportCanceled','captureLimited'];
    ['last','lastObserved','lastGeneration'].forEach(function(key) {
      const snap=input[key]; if (!snap || typeof snap!=='object') return;
      out[key]={};
      strings.concat(nums,bools).forEach(function(k) {
        const v=snap[k],type=strings.includes(k) ? 'string' : nums.includes(k) ? 'number' : 'boolean';
        if (v===null) out[key][k]=null;
        else if (typeof v===type && (type!=='number' || Number.isFinite(v))) out[key][k]=type==='string' ? v.slice(0,256) : v;
      });
      if (['event_limit','structure_limit','idle_timeout','pre_match_limit'].includes(snap.captureLimited)) out[key].captureLimited=snap.captureLimited;
      if (own(snap,'endpoint')) out[key].endpoint=endpoint(snap.endpoint);
    });
    if (Array.isArray(input.unknownMetaKeys)) out.unknownMetaKeys=input.unknownMetaKeys.slice(0,100).filter(function(k) { return typeof k==='string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(k) && !/(token|cookie|authorization|user_agent)/i.test(k); });
    out.unknownMetaTypes=Object.create(null);
    (out.unknownMetaKeys || []).forEach(function(k) { const t=input.unknownMetaTypes && input.unknownMetaTypes[k]; if (['string','number','boolean','object','array','null','undefined'].includes(t)) out.unknownMetaTypes[k]=t; });
    return out;
  }
  function send(msg,callback) {
    try { chrome.runtime.sendMessage(msg,function(res) {
      const error=chrome.runtime.lastError;
      if (callback) callback(error ? {ok:false,error:'扩展连接已断开'} : res);
    }); } catch (_) { if (callback) callback({ok:false,error:'扩展连接已断开'}); }
  }
  function ms(n) { return typeof n==='number' && Number.isFinite(n) && n>=0 ? Math.round(n)+' ms' : '未观察'; }
  function evidence(r) { return r.serverModel ? (r.resolvedModel ? (r.serverModel===r.resolvedModel ? 'Server + Resolved' : 'Server / Resolved 冲突') : '仅 Server 证据') : r.resolvedModel ? '仅 Resolved 证据' : r.messageModel ? '仅 Message 证据' : '实际模型未观察'; }
  function buildWidget() {
    if (STATE.el) return;
    const root=document.createElement('div');
    root.id='mri-floating-root'; root.setAttribute('data-mri','1');
    root.style.cssText='all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none;';
    // Shadow DOM prevents the host page stylesheet from breaking keyboard controls/layout.
    const shadow=root.attachShadow({mode:'closed'});
    const style=document.createElement('style');
    style.textContent=':host{color-scheme:dark}*{box-sizing:border-box}.card{pointer-events:auto;position:relative;width:310px;max-width:calc(100vw - 24px);padding:8px 30px 8px 10px;border:1px solid #485365;border-radius:9px;background:#1b212cf2;color:#edf1f8;box-shadow:0 4px 18px #0005;font:11px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.name{font-size:12px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.sub,.metrics{font-size:10px;color:#b6c2d5;margin-top:3px;overflow-wrap:anywhere}.metrics{font-variant-numeric:tabular-nums}.storage{color:#ffbc8d;font-size:10px;margin-top:3px}button{position:absolute;right:5px;top:5px;appearance:none;border:0;border-radius:4px;background:transparent;color:#b6c2d5;cursor:pointer;font-size:17px;line-height:1;padding:3px}button:hover{background:#39465a}button:focus-visible{outline:2px solid #8ebcff}';
    const card=document.createElement('section'); card.className='card'; card.setAttribute('aria-label','Model Route Inspector 路由状态');
    const name=document.createElement('div'); name.className='name';
    const sub=document.createElement('div'); sub.className='sub'; sub.setAttribute('role','status'); sub.setAttribute('aria-live','polite');
    const metrics=document.createElement('div'); metrics.className='metrics';
    const storage=document.createElement('div'); storage.className='storage'; storage.hidden=true;
    const close=document.createElement('button'); close.type='button'; close.textContent='×'; close.title='隐藏悬浮卡；可在插件弹窗重新开启'; close.setAttribute('aria-label','隐藏悬浮卡');
    close.addEventListener('click',function() { close.disabled=true; send({type:'mri-disable-floating'},function(res) {
      close.disabled=false;
      if (res && res.ok===true) { STATE.floatingEnabled=false; hideWidget(); }
      else { storage.hidden=false; storage.textContent='隐藏设置未保存，请重试'; }
    }); });
    card.append(name,sub,metrics,storage,close); shadow.append(style,card);
    Object.assign(STATE,{el:root,name,sub,metrics,storage});
  }
  function hideWidget() { if (STATE.el) STATE.el.remove(); }
  function render(rec) {
    STATE.lastRecord=rec;
    if (!STATE.floatingEnabled) { hideWidget(); return; }
    buildWidget();
    if (!STATE.el.isConnected) (document.body || document.documentElement).appendChild(STATE.el);
    const actual=rec.serverModel || rec.resolvedModel || rec.messageModel;
    const model=(actual || rec.requestedModel || '模型未观察').replace(/^gpt-/i,'');
    const label=STATUS[rec.status]+' · '+(actual ? model : rec.requestedModel ? '请求 '+model : model);
    const sub=evidence(rec)+' · '+(rec.streamComplete===true ? '流已完成' : '未观察完成标志')+
      ((rec.transportCanceled===true || rec.aborted===true) ? ' · 传输已取消' : '')+(rec.captureLimited ? ' · 采集受限' : '');
    const metrics='首文 '+ms(rec.firstTextMs)+' · 总 '+ms(rec.totalMs)+(rec.thinkingEffort ? ' · 思考 '+rec.thinkingEffort : '');
    const signature=label+'\n'+sub+'\n'+metrics;
    if (STATE.signature===signature) return;
    STATE.signature=signature;
    STATE.name.textContent=label; STATE.name.title=(rec.requestedModel || '请求未观察')+' → '+(actual || '实际模型未观察');
    STATE.name.style.color=COLORS[rec.status]; STATE.sub.textContent=sub; STATE.metrics.textContent=metrics;
  }
  window.addEventListener('message',function(ev) {
    if (ev.source!==window || ev.origin!==location.origin) return;
    const msg=ev.data;
    if (!msg || msg.source!=='mri' || msg.type!=='record') return;
    const rec=safeRecord(msg.record);
    if (!rec) return;
    render(rec);
    send({type:'mri-record',record:rec},function(res) {
      if (!STATE.storage || STATE.lastRecord!==rec) return;
      STATE.storage.hidden=!!(res && res.ok===true);
      STATE.storage.textContent=STATE.storage.hidden ? '' : '历史保存失败；当前卡片仅为本页观察';
    });
  });
  chrome.runtime.onMessage.addListener(function(msg,_sender,sendResponse) {
    if (!msg) return;
    if (msg.target==='mri-content') {
      if (msg.type==='mri-floating-setting') {
        STATE.floatingEnabled=msg.enabled===true;
        if (STATE.floatingEnabled && STATE.lastRecord) render(STATE.lastRecord); else hideWidget();
      } else if (msg.type==='mri-floating-refresh' && STATE.lastRecord) render(STATE.lastRecord);
      return;
    }
    if (msg.type!=='mri-get-diag') return;
    let settled=false,timer;
    const requestId='diag-'+crypto.randomUUID();
    function finish(response) {
      if (settled) return;
      settled=true; clearTimeout(timer); window.removeEventListener('message',onReply); sendResponse(response);
    }
    function onReply(ev) {
      const m=ev.data;
      if (ev.source!==window || ev.origin!==location.origin || !m || m.source!=='mri' || m.type!=='diag' || m.requestId!==requestId) return;
      const diag=safeDiag(m.diag);
      finish(diag ? {ok:true,diag:diag} : {ok:false,error:'诊断数据无效'});
    }
    window.addEventListener('message',onReply);
    timer=setTimeout(function() {finish({ok:false,error:'注入脚本未响应，请刷新 ChatGPT 页面'});},800);
    window.postMessage({source:'mri',type:'diag-request',requestId:requestId},location.origin);
    return true;
  });
  if (typeof module!=='undefined' && module.exports) module.exports={safeRecord,safeDiag,ms,evidence};
  send({type:'mri-content-ready'});
})();

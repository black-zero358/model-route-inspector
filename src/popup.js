/* Popup: compact summaries, lazy details, explicit evidence and independent completion. */
(function () {
  'use strict';
  // Set an intrinsic width for the action surface; ordinary tabs stay responsive.
  if (location.protocol === 'chrome-extension:') document.documentElement.setAttribute('data-surface','extension-popup');
  const STATUS = { match:'一致', mismatch:'切换', unknown:'待确认', conflict:'冲突' };
  let records = [];
  let refreshVersion = 0;
  let diagVersion = 0;
  const byId = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, function (c) { return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function short(s) { return s ? String(s).replace(/^gpt-/i, '') : '未观察'; }
  function date(ts, full) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '时间未记录';
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '时间无效';
    const p = function (n) { return String(n).padStart(2,'0'); };
    return (full ? d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' ' : '')+p(d.getHours())+':'+p(d.getMinutes())+(full ? ':'+p(d.getSeconds()) : '');
  }
  function ms(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n)+' ms' : '未观察'; }
  function value(r, key, unit) {
    const v = r[key], state = r.fieldStates && r.fieldStates[key];
    if (state === 'invalid') return '<span class="missing">类型异常</span>';
    if (state === 'null') return '<span class="missing">明确 null</span>';
    if (state === 'empty' || v === '') return '<span class="missing">空值</span>';
    if (v === null || v === undefined) return '<span class="missing">未观察</span>';
    if (unit === 'ms') return esc(ms(v));
    if (key === 'cancelReason' && v === 'unknown') return '未知（未确认发起方）';
    if (key === 'captureLimited' && typeof v === 'string') return esc(({idle_timeout:'观察器空闲超时',event_limit:'单事件超限',structure_limit:'事件结构超限',pre_match_limit:'识别前读取超限'})[v] || v);
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (Array.isArray(v)) return esc(v.length ? v.join(' · ') : '空列表 []');
    if (typeof v === 'object') return '<span class="missing">类型异常</span>';
    return esc(v)+(unit ? ' '+esc(unit) : '');
  }
  function row(label, r, key, unit, hint) {
    const source = r.fieldSources && r.fieldSources[key];
    return '<div class="k">'+esc(label)+'</div><div class="v"'+(source ? ' title="来源：'+esc(source)+'"' : '')+'>'+value(r,key,unit)+(hint ? '<span class="hint">'+esc(hint)+'</span>' : '')+'</div>';
  }
  function textRow(label, text) { return '<div class="k">'+esc(label)+'</div><div class="v">'+esc(text)+'</div>'; }
  function group(title, body) { return '<div class="group-title">'+esc(title)+'</div><div class="kv">'+body+'</div>'; }
  function more(title, body) { return '<details class="more"><summary>'+esc(title)+'</summary>'+body+'</details>'; }
  function evidence(r) {
    if (r.serverModel && r.resolvedModel) return r.serverModel === r.resolvedModel ? 'Server + Resolved 证据' : 'Server / Resolved 冲突';
    if (r.serverModel) return '仅 Server 证据';
    if (r.resolvedModel) return '仅 Resolved 证据';
    if (r.messageModel) return '仅 Message 证据';
    return '实际模型证据未观察';
  }
  function completion(r) { return r.streamComplete === true ? '流已完成' : '未观察完成标志'; }
  function canceled(r) { return r.transportCanceled === true || r.aborted === true; }
  function derived(r) {
    const hints = [];
    if (r.turnUseCase === 'search') hints.push('检测到搜索（派生自 turnUseCase=search）');
    if (r.turnUseCase === 'multimodal') hints.push('检测到多模态（派生自 turnUseCase=multimodal）');
    if (r.didPromptContainImage === true) hints.push('检测到图片输入（派生自 didPromptContainImage=true）');
    return hints.join('；') || '未观察可派生的任务证据';
  }
  function buildDetail(r) {
    const timingHint = r.timingSource ? '从发起请求计时（'+String(r.timingSource)+'）' : '旧记录：计时起点未确认';
    const sources = Object.keys(r.fieldSources || {}).filter(function(k) { return typeof r.fieldSources[k] === 'string'; }).sort()
      .map(function(k) { return textRow(k,r.fieldSources[k]); }).join('');
    return group('模型与证据',
      row('Requested 请求',r,'requestedModel')+row('Resolved 路由',r,'resolvedModel')+row('Server 服务端',r,'serverModel')+
      row('Message 消息',r,'messageModel')+textRow('证据范围',evidence(r)))+
      group('流状态与时序',
        textRow('生成状态',completion(r))+textRow('传输取消',canceled(r) ? '是；与生成完成独立' : r.transportCanceled === false ? '否' : '未观察')+
        row('完成标志',r,'completionSignals')+row('取消来源',r,'cancelReason')+
        row('响应头',r,'responseHeadersMs','ms')+row('首字节',r,'firstByteMs','ms')+
        row('首个回答文本',r,'firstTextMs','ms')+row('首个推理片段',r,'firstReasoningMs','ms')+
        row('流完成',r,'completionMs','ms')+row('观察总耗时',r,'totalMs','ms')+textRow('计时来源',timingHint)+
        row('推理时长',r,'reasoningDurationMs','ms',r.requestedExperience === 'instant' && r.reasoningDurationMs == null ? '不适用（由即时体验派生）；原值如上' : '服务端推理时钟；不与浏览器等待相加')+
        row('采集受限',r,'captureLimited'))+
      more('模式、工具与服务端调度',
        group('模式',row('用途',r,'turnUseCase')+row('思考强度',r,'thinkingEffort')+row('体验',r,'requestedExperience')+
          row('产品',r,'productExperience')+row('轮次模式',r,'turnMode')+row('默认模型',r,'defaultModel'))+
        group('任务证据',textRow('派生检测',derived(r))+row('调用工具',r,'toolInvoked')+row('工具名',r,'toolName')+
          row('搜索原值',r,'isSearch')+row('搜索调用数',r,'searchToolCallCount')+row('搜索类型',r,'searchToolQueryTypes')+
          row('多模态原值',r,'isMultimodal')+row('输入含图片',r,'didPromptContainImage'))+
        group('切换与调度',row('自动切换器',r,'isAutoswitcherEnabled')+row('切至推理',r,'didAutoSwitchToReasoning')+
          row('切换胜出模型',r,'autoSwitcherRaceWinner',null,r.isAutoswitcherEnabled === false ? '不适用：自动切换器未启用；原值如上' : null)+
          row('切换拒绝',r,'modelSwitcherDeny')+row('快速会话',r,'fastConvo')+row('预热状态',r,'warmupState')+
          row('管道已预热',r,'conduitPrewarmed')+row('首轮',r,'isFirstTurn')+
          row('账户计划',r,'planType')+row('计划分组',r,'planTypeBucket')))+
      more('传输、基础设施与追踪',
        group('传输',row('本轮传输',r,'transport')+row('端点',r,'endpoint')+row('HTTP',r,'responseStatus')+
          row('Content-Type',r,'contentType')+row('支持 WS 恢复',r,'resumeWithWebsockets',null,'恢复能力；不代表本轮使用 WebSocket'))+
        group('基础设施',row('集群区域',r,'clusterRegion')+row('区域原值',r,'region')+row('服务端 TTFVT',r,'serverTtfvt','ms')+
          row('服务端完成耗时',r,'finishedDurationSec','s')+row('推理开始',r,'reasoningStartTime','s')+row('推理结束',r,'reasoningEndTime','s'))+
        group('追踪',row('请求 ID',r,'requestId')+row('会话 ID',r,'conversationId')+row('消息 ID',r,'messageId')+
          row('服务端请求',r,'serverRequestId')+row('轮次交换',r,'turnExchangeId')+row('轮次追踪',r,'turnTraceId')+
          textRow('请求开始',date(r.startedAt,true))+textRow('观察结束',date(r.endedAt,true))+textRow('检测时间',date(r.timestamp,true))))+
      more('字段来源与兼容指标',
        '<div class="kv">'+(sources || textRow('来源','旧记录或本轮未观察字段来源'))+'</div>'+
        group('兼容指标',row('旧 firstDelta',r,'firstDeltaMs','ms','优先参考首个回答文本 / 首个推理片段')))+
      '<p class="reason">路由依据：'+esc(r.reason || '未提供')+'</p>';
  }
  function renderStats(stats) {
    function count(key) { return typeof stats[key] === 'number' && Number.isFinite(stats[key]) ? Math.max(0,Math.trunc(stats[key])) : 0; }
    const models=Object.entries(stats.modelCounts || {}).filter(function(e) { return typeof e[1]==='number' && Number.isFinite(e[1]) && e[1]>=0; }).sort(function(a,b) {return b[1]-a[1];});
    const breakdown=models.length ? '<details class="model-counts"><summary title="累计口径：优先 Server / Resolved / Message；缺失时计入请求模型或兼容 modelSlug">模型频次 · '+models.slice(0,3).map(function(e) {return esc(short(e[0]))+' '+Math.trunc(e[1]);}).join(' · ')+'</summary><div class="kv">'+models.map(function(e) {return textRow(short(e[0]),Math.trunc(e[1]));}).join('')+'</div></details>' : '';
    byId('stats').innerHTML = [['','totalRequests','累计'],['match','matchCount','一致'],['mismatch','mismatchCount','切换'],['unknown',null,'待定 / 冲突']].map(function(s) {
      return '<div class="stat '+s[0]+'"><span class="num">'+(s[1] ? count(s[1]) : count('unknownCount')+count('conflictCount'))+'</span><span class="lbl">'+s[2]+'</span></div>';
    }).join('')+breakdown;
  }
  function filterRecords(all, query, state) {
    const q = query.toLowerCase().trim();
    return all.filter(function(r) {
      return (state === 'all' || r.status === state) && (!q || ['requestedModel','resolvedModel','serverModel','messageModel','turnUseCase','endpoint','thinkingEffort','toolName'].some(function(k) { return typeof r[k] === 'string' && r[k].toLowerCase().includes(q); }));
    });
  }
  function renderList() {
    const list = byId('list');
    const visible = filterRecords(records,byId('filter-query').value,byId('filter-status').value);
    const indices = new Map(records.map(function(r,index) { return [r,index]; }));
    byId('record-count').textContent = '最近请求 '+visible.length+' / '+records.length;
    const fragment = document.createDocumentFragment();
    visible.forEach(function(r) {
      const item = document.createElement('details');
      item.className = 'item';
      item.dataset.index = String(indices.get(r));
      const status = Object.prototype.hasOwnProperty.call(STATUS,r.status) ? r.status : 'unknown';
      const actual = r.serverModel || r.resolvedModel || r.messageModel;
      const model = actual ? short(actual) : (r.requestedModel ? '请求 '+short(r.requestedModel) : '模型未观察');
      const route = r.requestedModel && actual && r.requestedModel !== actual ? '<span class="req">'+esc(short(r.requestedModel))+'</span><span class="arrow">→</span>' : '';
      item.innerHTML = '<summary><div class="topline"><span class="time">'+esc(date(r.timestamp || r.endedAt || r.startedAt))+'</span>'+
        '<span class="models" title="'+esc(r.requestedModel || '')+' → '+esc(actual || '实际模型未观察')+'">'+route+'<span class="actual">'+esc(model)+'</span></span>'+
        '<span class="status '+status+'">'+STATUS[status]+'</span><span class="chevron" aria-hidden="true">›</span></div>'+
        '<div class="summary-meta"><span>'+esc(evidence(r))+'</span><span class="'+(r.streamComplete ? 'complete' : '')+'">'+completion(r)+'</span>'+
        (canceled(r) ? '<span class="canceled">传输已取消</span>' : '')+
        (r.captureLimited ? '<span class="canceled">采集受限</span>' : '')+
        '<span>首文 '+esc(ms(r.firstTextMs))+'</span><span>总 '+esc(ms(r.totalMs))+'</span>'+
        (r.thinkingEffort ? '<span>思考 '+esc(r.thinkingEffort)+'</span>' : '')+'</div></summary>';
      fragment.appendChild(item);
    });
    list.replaceChildren(fragment);
    if (!visible.length) list.innerHTML = '<div class="empty">'+(records.length ? '没有符合筛选条件的记录。' : '还没有捕获记录。打开 ChatGPT 发送独立测试消息，或查看「诊断」。')+'</div>';
  }
  function diagLine(label, v, ok) { return '<div class="diag-row"><span class="k">'+esc(label)+'</span><span class="v '+(ok === true ? 'diag-ok' : ok === false ? 'diag-bad' : '')+'">'+esc(v === null || v === undefined ? '未观察' : v)+'</span></div>'; }
  function renderDiag(res) {
    if (!res || res.ok === false || !res.diag) {
      byId('diag-page').textContent = '';
      byId('diag-body').innerHTML = '<div class="diag-empty">无法读取页面诊断。请在 ChatGPT 标签页打开插件并刷新页面。<br>'+esc(res && res.error || '无响应')+'</div>';
      return;
    }
    const d=res.diag, L=d.lastGeneration || d.last || {}, O=d.lastObserved || {};
    byId('diag-page').textContent = d.href || '当前 ChatGPT 页面';
    let html='<section class="diag-section"><h4>采集状态</h4>';
    html+=diagLine('主世界注入',d.hookInstalled ? '已注入' : '未注入',d.hookInstalled)+diagLine('观察 fetch',d.fetchCalls)+
      diagLine('候选 / 生成流',String(d.candidates || 0)+' / '+String(d.matched || 0))+diagLine('产出记录',d.records);
    html+='</section><section class="diag-section"><h4>最近生成请求</h4>';
    html+=diagLine('端点',L.endpoint)+diagLine('方法 / HTTP',String(L.method || '未观察')+' / '+String(L.status == null ? '未观察' : L.status))+
      diagLine('本轮传输',L.transport)+diagLine('Content-Type',L.contentType)+diagLine('路由判定',L.judgment)+
      diagLine('Requested',L.requestedModel)+diagLine('Resolved',L.resolvedModel)+diagLine('Server',L.serverModel)+
      diagLine('SSE 块 / 事件',String(L.chunks || 0)+' / '+String(L.events || 0))+
      diagLine('Server 元数据',L.hasServerSte === true ? '已观察' : '未观察')+diagLine('Resolved 字段',L.hasResolved === true ? '已观察' : '未观察')+
      diagLine('解析错误',L.parserError || '无')+diagLine('传输错误',L.error || '无');
    html+='</section><section class="diag-section"><h4>最近观察请求（含 prepare / init 等）</h4>'+
      diagLine('端点',O.endpoint)+diagLine('匹配生成流',O.matched === true ? '是' : O.matched === false ? '否' : '未观察')+
      diagLine('HTTP / 传输',String(O.status == null ? '未观察' : O.status)+' / '+String(O.transport || '未观察'))+'</section>';
    if (Array.isArray(d.unknownMetaKeys) && d.unknownMetaKeys.length) html+='<section class="diag-section"><h4>未识别 metadata 名称 / 类型（不保存值）</h4><div class="v">'+esc(d.unknownMetaKeys.map(function(k) { return k+(d.unknownMetaTypes && d.unknownMetaTypes[k] ? ' ('+d.unknownMetaTypes[k]+')' : ''); }).join(' · '))+'</div></section>';
    byId('diag-body').innerHTML=html;
  }
  function notice(text) { byId('notice').textContent=text || ''; byId('notice').hidden=!text; }
  function send(msg, tabId) {
    return new Promise(function(resolve) {
      try {
        const callback=function(res) { const error=chrome.runtime.lastError; resolve(error ? {ok:false,error:'通信失败，请重新打开插件'} : res); };
        if (tabId === undefined) chrome.runtime.sendMessage(msg,callback); else chrome.tabs.sendMessage(tabId,msg,callback);
      } catch (_) { resolve({ok:false,error:'扩展连接已断开，请刷新页面'}); }
    });
  }
  function failed(res) { if (!res || res.ok === false) { notice(res && res.error || '操作没有收到确认'); return true; } return false; }
  async function refreshRecords() {
    const version=++refreshVersion, res=await send({type:'mri-get-data'});
    if (version !== refreshVersion || failed(res)) return;
    records=(Array.isArray(res.records) ? res.records : []).filter(function(r) { return r && typeof r === 'object'; }).sort(function(a,b) { return (b.timestamp || b.endedAt || b.startedAt || 0)-(a.timestamp || a.endedAt || a.startedAt || 0); });
    renderStats(res.stats || {}); renderList();
    const enabled=!!(res.settings && res.settings.floatingEnabled), btn=byId('btn-floating');
    btn.textContent='悬浮 '+(enabled ? '开' : '关'); btn.dataset.enabled=enabled ? '1':'0'; btn.setAttribute('aria-pressed',String(enabled));
  }
  async function refreshDiag() {
    const version=++diagVersion;
    byId('diag-body').innerHTML='<div class="diag-empty">读取中…</div>';
    const tabs=await new Promise(function(resolve) { try { chrome.tabs.query({active:true,currentWindow:true},function(t) { const err=chrome.runtime.lastError; resolve(err ? [] : t); }); } catch (_) { resolve([]); } });
    const tab=tabs && tabs[0];
    const res=tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(tab.url || '') ? await send({type:'mri-get-diag'},tab.id) : {ok:false,error:'当前标签页不是 ChatGPT'};
    if (version === diagVersion) renderDiag(res);
  }
  function download(name,text,mime) {
    const url=URL.createObjectURL(new Blob([text],{type:mime}));
    const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function() { URL.revokeObjectURL(url); },1000);
  }
  async function action(button, task) {
    if (button.disabled) return;
    button.disabled=true; notice('');
    try { await task(); } catch (_) { notice('操作失败，请重试或查看诊断'); } finally { button.disabled=false; }
  }
  // Pure helpers are exported only in the Node regression harness.
  if (typeof module !== 'undefined' && module.exports) module.exports={esc,value,ms,evidence,completion,canceled,derived,buildDetail,filterRecords,date,renderStats};
  document.addEventListener('DOMContentLoaded',function() {
    document.querySelectorAll('.tab').forEach(function(t) { t.addEventListener('click',function() {
      document.querySelectorAll('.tab').forEach(function(x) { x.classList.toggle('active',x===t); x.setAttribute('aria-pressed',String(x===t)); });
      document.querySelectorAll('.tab-panel').forEach(function(x) { x.classList.toggle('active',x.id==='tab-'+t.dataset.tab); });
      if (t.dataset.tab==='diag') refreshDiag();
    }); });
    // Capturing native toggle events gives one listener for all lazy record details.
    byId('list').addEventListener('toggle',function(event) {
      const item=event.target;
      if (!item.classList.contains('item') || !item.open || item.querySelector('.detail')) return;
      const r=records[Number(item.dataset.index)];
      if (!r) return;
      const detail=document.createElement('div'); detail.className='detail'; detail.innerHTML=buildDetail(r); item.appendChild(detail);
    },true);
    byId('filter-query').addEventListener('input',renderList);
    byId('filter-status').addEventListener('change',renderList);
    byId('btn-refresh').addEventListener('click',function() { action(this,refreshRecords); });
    byId('btn-clear').addEventListener('click',function() { const btn=this; if (!confirm('确定清空全部历史记录和累计统计？')) return; action(btn,async function() { const res=await send({type:'mri-clear'}); if (!failed(res)) await refreshRecords(); }); });
    ['json','csv'].forEach(function(format) { byId('btn-'+format).addEventListener('click',function() { action(this,async function() {
      const res=await send({type:'mri-export-'+format}); if (failed(res)) return;
      if (typeof res[format] !== 'string') { notice('导出未返回有效内容'); return; }
      download('mri-'+Date.now()+'.'+format,res[format],format==='json' ? 'application/json' : 'text/csv;charset=utf-8');
    }); }); });
    byId('btn-floating').addEventListener('click',function() { const btn=this; action(btn,async function() { const res=await send({type:'mri-set-floating',enabled:btn.dataset.enabled!=='1'}); if (!failed(res)) await refreshRecords(); }); });
    byId('btn-diag-refresh').addEventListener('click',function() { action(this,refreshDiag); });
    refreshRecords();
  });
})();

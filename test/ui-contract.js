'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
let passed=0;
function test(name,fn) { fn(); passed++; console.log('PASS '+name); }
const source=path.join(__dirname,'../src');
function load(file,extra) {
  const listeners={};
  const context={module:{exports:{}},document:{addEventListener(){}},window:{addEventListener(type,fn){(listeners[type] ||= []).push(fn);},removeEventListener(){}},location:{origin:'https://chatgpt.com'},URL,Set,Map,Promise,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,chrome:{runtime:{sendMessage(_msg,cb){if(cb)cb({ok:true});},onMessage:{addListener(){}}}},...extra};
  vm.runInNewContext(fs.readFileSync(path.join(source,file),'utf8'),context,{filename:file});
  return {api:context.module.exports,context,listeners};
}
const P=load('popup.js').api;
const C=load('content.js').api;
test('explicit null differs from unobserved',()=>{
  assert.match(P.value({region:null,fieldStates:{region:'null'}},'region'),/明确 null/);
  assert.match(P.value({region:null,fieldStates:{}},'region'),/未观察/);
});
test('empty, invalid and false remain distinct',()=>{
  assert.match(P.value({region:'',fieldStates:{region:'empty'}},'region'),/空值/);
  assert.match(P.value({region:{},fieldStates:{region:'invalid'}},'region'),/类型异常/);
  assert.equal(P.value({toolInvoked:false},'toolInvoked'),'否');
});
test('milliseconds round, accept zero, reject invalid/negative',()=>{
  assert.equal(P.ms(0),'0 ms'); assert.equal(P.ms(2.67),'3 ms');
  assert.equal(P.ms(-1),'未观察'); assert.equal(P.ms(Infinity),'未观察');
});
test('only Resolved does not claim Server evidence or completed',()=>{
  const r={resolvedModel:'gpt-6',streamComplete:false};
  assert.equal(P.evidence(r),'仅 Resolved 证据'); assert.equal(P.completion(r),'未观察完成标志');
});
test('completion and cancellation can both be true',()=>{
  const r={streamComplete:true,transportCanceled:true};
  assert.equal(P.completion(r),'流已完成'); assert.equal(P.canceled(r),true);
});
test('limited observer does not imply user stop or completion',()=>{
  assert.equal(P.completion({captureLimited:'idle_timeout'}),'未观察完成标志');
  assert.equal(P.canceled({captureLimited:'idle_timeout'}),false);
});
test('derived evidence does not overwrite authoritative null',()=>{
  const r={turnUseCase:'multimodal',didPromptContainImage:true,isMultimodal:null,fieldStates:{isMultimodal:'null'}};
  assert.match(P.derived(r),/派生自/); assert.match(P.value(r,'isMultimodal'),/明确 null/);
});
test('details expose correct WS capability, endpoint, sources and units',()=>{
  const html=P.buildDetail({resumeWithWebsockets:true,transport:'sse',endpoint:'/backend-api/f/conversation',fieldSources:{resolvedModel:'v.message.metadata.resolved_model_slug'},firstTextMs:3.8});
  assert.match(html,/支持 WS 恢复/); assert.match(html,/不代表本轮使用 WebSocket/);
  assert.match(html,/4 ms/); assert.match(html,/v.message.metadata.resolved_model_slug/);
});
test('all record and source markup is escaped',()=>{
  const html=P.buildDetail({requestedModel:'<img src=x onerror=alert(1)>',reason:'<script>x</script>',fieldSources:{requestedModel:'x" onclick="oops'}});
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.match(html,/&quot;/);
});
test('status filter and model/use case/endpoint search',()=>{
  const records=[{status:'match',serverModel:'gpt-6',turnUseCase:'search'},{status:'unknown',endpoint:'/backend-api/f/conversation'}];
  assert.equal(P.filterRecords(records,'SEARCH','match').length,1);
  assert.equal(P.filterRecords(records,'conversation','all').length,1);
  assert.equal(P.filterRecords(records,'gpt','unknown').length,0);
});
test('invalid dates never fabricate current time',()=>{
  assert.equal(P.date(undefined),'时间未记录'); assert.equal(P.date(NaN),'时间未记录'); assert.equal(P.date(9e15),'时间无效');
});
test('bridge whitelist excludes body, cookies, arbitrary objects and raw URL',()=>{
  const record=C.safeRecord({status:'match',requestId:'safe',serverModel:'gpt-6',body:'private',cookie:'secret',url:'https://chatgpt.com/c/private?token=secret',autoSwitcherRaceWinner:{prompt:'private'},toolName:'SonicBrowserTool'});
  assert.equal(record.toolName,'SonicBrowserTool'); assert.equal(record.body,undefined); assert.equal(record.cookie,undefined); assert.equal(record.url,undefined); assert.equal(record.autoSwitcherRaceWinner,undefined);
});
test('bridge preserves all completion timing fields and limit reasons',()=>{
  const record=C.safeRecord({status:'unknown',requestId:'safe',firstTextMs:0,firstReasoningMs:12.5,completionMs:120,streamComplete:true,transportCanceled:true,captureLimited:'idle_timeout'});
  assert.equal(record.firstTextMs,0); assert.equal(record.completionMs,120); assert.equal(record.captureLimited,'idle_timeout'); assert.equal(record.streamComplete,true);
});
test('inline bridge retains exact IDs and tools without arguments or inferred counts',()=>{
  const r=C.safeRecord({status:'match',requestId:'safe',assistantMessageIds:['assistant-a','bad/private'],inputMessageIds:['input-a'],requestedThinkingEffort:'max',firstTokenMs:0,firstTokenSource:'marker.reasoning',toolEvidence:'observed',toolCalls:[{name:'web.run',count:null,status:'observed',durationMs:null,arguments:'private',id:'private'},{name:'bad tool raw value',count:1}]});
  assert.equal(r.assistantMessageIds.join(','),'assistant-a');assert.equal(r.inputMessageIds.join(','),'input-a');assert.equal(r.firstTokenMs,0);assert.equal(r.firstTokenSource,'marker.reasoning');assert.equal(r.requestedThinkingEffort,'max');assert.equal(r.toolCalls.length,1);assert.equal(r.toolCalls[0].count,null);assert.equal(r.toolCalls[0].durationMs,null);assert.equal(r.toolCalls[0].arguments,undefined);assert.equal(r.toolCalls[0].id,undefined);
});
test('inline bridge constrains tool statuses counts timing and source enums',()=>{
  const r=C.safeRecord({status:'unknown',requestId:'safe',firstTokenSource:'arbitrary raw value',toolEvidence:'none',toolCalls:[{name:'web.run',count:-1,status:'private status',durationMs:Infinity}]});
  assert.equal(r.firstTokenSource,undefined);assert.equal(r.toolEvidence,undefined);assert.equal(r.toolCalls[0].count,null);assert.equal(r.toolCalls[0].durationMs,null);assert.equal(r.toolCalls[0].status,'observed');
});
test('variant bridge preserves safe parent/action without fabricating input IDs',()=>{const r=C.safeRecord({status:'match',requestId:'variant',requestAction:'variant',requestedParentMessageId:'synthetic-input',inputMessageIds:[]});assert.equal(r.requestAction,'variant');assert.equal(r.requestedParentMessageId,'synthetic-input');assert.equal(r.inputMessageIds.length,0);const bad=C.safeRecord({status:'unknown',requestId:'bad',requestAction:'raw value',requestedParentMessageId:'bad/private'});assert.equal(bad.requestAction,undefined);assert.equal(bad.requestedParentMessageId,undefined);});
test('bridge maps are constrained by whitelist and state vocabulary',()=>{
  const r=C.safeRecord({status:'match',requestId:'safe',fieldStates:{region:'null',body:'value',serverModel:'oops'},fieldSources:{region:'metadata.region',body:'private',serverModel:'bad path with raw values'}});
  assert.equal(r.fieldStates.region,'null'); assert.equal(r.fieldStates.body,undefined); assert.equal(r.fieldStates.serverModel,undefined); assert.equal(r.fieldSources.region,'metadata.region'); assert.equal(r.fieldSources.serverModel,undefined);
});
test('bridge rejects malformed envelopes and non-finite numbers',()=>{
  assert.equal(C.safeRecord({status:'<script>',requestId:'safe'}),null);
  assert.equal(C.safeRecord({status:'match'}),null);
  assert.equal(C.safeRecord({status:'match',requestId:'safe',totalMs:Infinity}).totalMs,undefined);
});
test('bridge bounds strings and arrays and ignores object elements',()=>{
  const r=C.safeRecord({status:'match',requestId:'x'.repeat(400),completionSignals:['[DONE]',{prompt:'private'}],reason:'r'.repeat(800)});
  assert.equal(r.requestId.length,256); assert.equal(r.reason.length,256); assert.equal(r.completionSignals.length,1);
});
test('bridge does not accept inherited record properties',()=>{
  assert.equal(C.safeRecord(Object.create({status:'match',requestId:'inherited'})),null);
});
test('diagnostics remove page path, arbitrary data and sensitive names',()=>{
  const d=C.safeDiag({href:'https://chatgpt.com/c/private?token=secret',lastGeneration:{endpoint:'/backend-api/f/conversation',body:'private',captureLimited:'event_limit'},unknownMetaKeys:['some_new_key','access_token','user_agent']});
  assert.equal(d.href,'https://chatgpt.com'); assert.equal(d.lastGeneration.body,undefined); assert.equal(d.lastGeneration.captureLimited,'event_limit'); assert.equal(d.unknownMetaKeys.join(','),'some_new_key');
});
test('route endpoint sanitizer excludes query and private identifier paths',()=>{
  assert.equal(C.safeRecord({status:'match',requestId:'safe',endpoint:'/backend-api/f/conversation?access_token=secret'}).endpoint,'/backend-api/f/conversation');
  assert.equal(C.safeRecord({status:'match',requestId:'safe',endpoint:'/backend-api/conversation/private-identifier'}).endpoint,null);
  assert.equal(C.safeRecord({status:'match',requestId:'safe',endpoint:'https://example.com/backend-api/f/conversation'}).endpoint,null);
});
test('model frequency summary retains distribution without HTML injection',()=>{
  const stats={innerHTML:''};
  const ui=load('popup.js',{document:{addEventListener(){},getElementById(){return stats;}}}).api;
  ui.renderStats({totalRequests:2,modelCounts:{'<img src=x onerror=alert(1)>':2,'gpt-6':1}});
  assert.match(stats.innerHTML,/模型频次/); assert.ok(!stats.innerHTML.includes('<img')); assert.match(stats.innerHTML,/&lt;img/); assert.match(stats.innerHTML,/Server \/ Resolved \/ Message/);
});
test('diagnostic reply requires matching nonce and clears listener/timer',()=>{
  let handler,posted,result,removed=0; const timers=new Map();
  const h=load('content.js',{setTimeout(fn){timers.set(1,fn);return 1;},clearTimeout(id){timers.delete(id);},chrome:{runtime:{sendMessage(_m,cb){if(cb)cb({ok:true});},onMessage:{addListener(fn){handler=fn;}}}}});
  h.context.window.postMessage=function(m){posted=m;}; h.context.window.removeEventListener=function(){removed++;};
  assert.equal(handler({type:'mri-get-diag'},null,r=>{result=r;}),true);
  const reply=h.listeners.message.at(-1);
  reply({source:h.context.window,origin:'https://chatgpt.com',data:{source:'mri',type:'diag',requestId:'wrong',diag:{version:3}}});
  assert.equal(result,undefined);
  reply({source:h.context.window,origin:'https://chatgpt.com',data:{source:'mri',type:'diag',requestId:posted.requestId,diag:{version:3}}});
  assert.equal(result.ok,true); assert.equal(timers.size,0); assert.equal(removed,1);
});
test('optional inline initialization failure cannot block the bridge or history',()=>{
  const registered=[],sent=[],attrs={};
  const win={addEventListener(type,fn){if(type==='message')registered.push(fn);},removeEventListener(){}};
  const h=load('content.js',{window:win,document:{documentElement:{setAttribute(k,v){attrs[k]=v;}},querySelectorAll(){return [];},addEventListener(){}},MRIInline:{createController(){assert.equal(registered.length,1);throw new Error('synthetic optional UI failure');}},chrome:{runtime:{sendMessage(m,cb){sent.push(m);if(cb)cb({ok:true});},onMessage:{addListener(){}}}}});
  assert.equal(attrs['data-mri-content-ready'],'true');assert.equal(attrs['data-mri-inline-ready'],'false');
  registered[0]({source:h.context.window,origin:'https://chatgpt.com',data:{source:'mri',type:'record',record:{status:'match',requestId:'safe',serverModel:'gpt-6'}}});
  assert.ok(sent.some(m=>m.type==='mri-record'));
});
test('document_start bridge works before HTML exists and publishes only health booleans',()=>{
  const callbacks=[],attrs={},sent=[],doc={documentElement:null,querySelectorAll(){return [];},addEventListener(type,fn){if(type==='DOMContentLoaded')callbacks.push(fn);}};
  const h=load('content.js',{document:doc,chrome:{runtime:{sendMessage(m,cb){sent.push(m);if(cb)cb({ok:true});},onMessage:{addListener(){}}}}});
  h.listeners.message[0]({source:h.context.window,origin:'https://chatgpt.com',data:{source:'mri',type:'record',record:{status:'unknown',requestId:'safe',body:'private'}}});
  assert.ok(sent.some(m=>m.type==='mri-record'));assert.equal(sent.find(m=>m.type==='mri-record').record.body,undefined);
  doc.documentElement={setAttribute(k,v){attrs[k]=v;}};callbacks.forEach(fn=>fn());
  assert.equal(attrs['data-mri-content-ready'],'true');assert.equal(attrs['data-mri-inline-ready'],'false');assert.equal(attrs['data-mri-content-version'],'inline-v1-root-safe');assert.equal(Object.keys(attrs).length,3);
});
test('history uses native keyboard controls and one lazy toggle listener',()=>{
  const html=fs.readFileSync(path.join(source,'popup.html'),'utf8'),js=fs.readFileSync(path.join(source,'popup.js'),'utf8');
  assert.match(html,/aria-label="搜索模型、用途或端点"/);
  assert.match(js,/createElement\('details'\)/); assert.match(js,/addEventListener\('toggle'/);
  assert.ok(!js.includes("querySelector('.item-row').addEventListener"));
});
test('action popup declares its intrinsic surface before the first stylesheet',()=>{
  let surface;
  load('popup.js',{location:{protocol:'chrome-extension:'},document:{documentElement:{setAttribute(k,v){surface=[k,v];}},addEventListener(){}}});
  assert.deepEqual(surface,['data-surface','extension-popup']);
  const html=fs.readFileSync(path.join(source,'popup.html'),'utf8');
  assert.ok(html.indexOf('<script src="popup.js"')<html.indexOf('<link rel="stylesheet"'));
  assert.equal((html.match(/src="popup.js"/g)||[]).length,1);
  assert.ok(!/<script(?![^>]*src=)[^>]*>\s*\S/.test(html),'MV3 must not depend on inline JavaScript');
});
test('ordinary web preview does not acquire the action popup minimum',()=>{
  load('popup.js',{location:{protocol:'http:'},document:{documentElement:{setAttribute(){throw Error('web surface must remain responsive');}},addEventListener(){}}});
});
test('intrinsic popup size is definite and the content panel owns vertical scrolling',()=>{
  const css=fs.readFileSync(path.join(source,'popup.css'),'utf8');
  const popup=css.match(/html\[data-surface="extension-popup"\]\s*\{([^}]+)\}/)[1];
  assert.match(popup,/(?:^|;)\s*width:490px/); assert.match(popup,/min-width:490px/); assert.match(popup,/height:600px/);
  assert.ok(!/(vw|vh|%|min\()/i.test(popup),'popup minimum must not cycle through the initial viewport');
  assert.match(css,/\.tab-panel\.active\s*\{[^}]*min-height:0[^}]*overflow-y:auto/);
  for(const selector of ['.list','.diag-body','.model-counts .kv']) {
    const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const declaration=css.match(new RegExp(escaped+'\\s*\\{([^}]+)\\}'))[1];
    assert.ok(!/overflow|max-height/.test(declaration),selector+' must not create a second vertical scroller');
  }
});
console.log('UI contract: '+passed+' checks passed.');

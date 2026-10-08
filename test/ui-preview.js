/* Local synthetic-only browser preview. pnpm exec node model-route-inspector/test/ui-preview.js */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const src=path.join(__dirname,'../src');
const {execFileSync}=require('node:child_process');
let baseline={};
try {
  for(const file of ['popup.html','popup.js','popup.css']) baseline[file]=execFileSync('git',['show','a3f2d82040aed8afbf64224e93ff4602fa7b3340:src/'+file],{cwd:path.join(__dirname,'..'),encoding:'utf8',stdio:['ignore','pipe','pipe']});
} catch (_) {
  baseline=null;
  console.warn('Original a3f2 baseline unavailable; comparison routes return 503. Current synthetic preview remains available.');
}
const records=[
  {requestId:'synthetic-complete',status:'match',requestedModel:'gpt-6-thinking',resolvedModel:'gpt-6-thinking',serverModel:'gpt-6-thinking',messageModel:'gpt-6-thinking',timestamp:1791421200000,startedAt:1791421190000,endedAt:1791421200000,streamComplete:true,transportCanceled:true,cancelReason:'unknown',completionSignals:['message_stream_complete','[DONE]'],responseHeadersMs:2770.35,firstByteMs:2800.8,firstTextMs:3121.75,firstReasoningMs:2850.6,completionMs:9800.2,totalMs:9938.7,reasoningDurationMs:6400,timingSource:'performance.now',transport:'sse',endpoint:'/backend-api/f/conversation',thinkingEffort:'max',turnUseCase:'multimodal',didPromptContainImage:true,isMultimodal:null,region:null,isAutoswitcherEnabled:false,autoSwitcherRaceWinner:null,resumeWithWebsockets:true,fieldStates:{isMultimodal:'null',region:'null',autoSwitcherRaceWinner:'null'},fieldSources:{serverModel:'metadata.model_slug',resolvedModel:'v.message.metadata.resolved_model_slug',region:'metadata.region'},reason:'请求与 Server / Resolved 一致；完成标志和传输取消分别记录。'},
  {requestId:'synthetic-stop',status:'match',requestedModel:'gpt-6',resolvedModel:'gpt-6',timestamp:1791421100000,streamComplete:false,transportCanceled:true,cancelReason:'unknown',transport:'sse',completionSignals:[],firstTextMs:1120.7,totalMs:2300.44,endpoint:'/backend-api/f/conversation',timingSource:'performance.now',reason:'仅 Resolved 模型一致；未观察完成标志；取消发起方未知。'},
  {requestId:'synthetic-long',status:'mismatch',requestedModel:'gpt-6-thinking-long-model-name-for-layout-validation',serverModel:'gpt-5.6-sol-thinking-long-model-name-for-layout-validation',timestamp:1791421000000,firstTextMs:0,totalMs:6100.35,streamComplete:true,completionSignals:['[DONE]'],turnUseCase:'search',toolName:'SonicBrowserTool',thinkingEffort:'high',endpoint:'/backend-api/f/conversation',reason:'合成模型切换记录，仅用于长字段布局检查。'},
  {requestId:'synthetic-limited',status:'unknown',requestedModel:'gpt-6-thinking',timestamp:1791420900000,streamComplete:false,transportCanceled:false,captureLimited:'idle_timeout',completionSignals:[],firstTextMs:null,totalMs:120000,endpoint:'/backend-api/f/conversation',reason:'合成观察器空闲超时；未知生成是否完成。'},
  {requestId:'synthetic-conflict',status:'conflict',requestedModel:'gpt-6-thinking',resolvedModel:'gpt-6-thinking',serverModel:'gpt-6',timestamp:1791420800000,streamComplete:true,firstTextMs:200,totalMs:8000,reason:'合成 Server / Resolved 冲突。'},
  {requestId:'synthetic-sparse',status:'unknown',requestedModel:'gpt-6-mini',timestamp:1791420700000,region:null,fieldStates:{region:'null'},reason:'合成空缺字段记录；仅有请求模型，未观察实际模型。'}
];
function inlineTurnMarkup(id,body){
  const shape=require('./fixtures/inline-dom-2026-10-08.json').turn;
  function render(spec){const attrs=Object.entries(spec.attributes || {}).map(([k,v])=>k+'="'+(k==='data-turn-key' ? id : v)+'"').join(' '),classes=(spec.className || '')+(spec.attributes && spec.attributes['data-turn-key'] ? ' turn' : '');let children=(spec.children || []).map(render).join('');if(spec.testRole==='assistantControls')children='<div class="host-actions" aria-label="合成回复操作"><button aria-label="复制">▢</button><button aria-label="点赞">♧</button><button aria-label="朗读">◖</button><button aria-label="重新生成">↻</button><button aria-label="更多">···</button></div>';if(spec.testRole==='userControls')children='<div class="host-actions" aria-label="合成用户消息操作"><button aria-label="复制消息">▢</button><button aria-label="编辑消息">✎</button></div>';if(spec.attributes && spec.attributes['data-talvt-turn-state'])children='<p>'+body+'</p>'+children;return '<'+spec.tag+' class="'+classes+'" '+attrs+'>'+children+'</'+spec.tag+'>';}
  return render(shape);
}
function bootstrap(fail,count) {
  const preview=count ? Array.from({length:count},(_,i)=>({...records[i%records.length],requestId:'synthetic-'+i,timestamp:1791421200000-i})) : records;
  const stats={totalRequests:preview.length,matchCount:0,mismatchCount:0,conflictCount:0,unknownCount:0,modelCounts:{}};
  const statusKeys={match:'matchCount',mismatch:'mismatchCount',conflict:'conflictCount',unknown:'unknownCount'};
  for(const r of preview){
    stats[statusKeys[r.status]]++;
    const actual=r.serverModel || r.resolvedModel || r.messageModel || r.requestedModel || r.modelSlug;
    if(actual) stats.modelCounts[actual]=(stats.modelCounts[actual] || 0)+1;
  }
  return `<script>
    var previewRecords=${JSON.stringify(preview)},previewStats=${JSON.stringify(stats)},previewFailure=${JSON.stringify(fail)},floatingEnabled=true;
    window.chrome={
      runtime:{
        sendMessage:function(msg,cb){
          var res;
          if(previewFailure&&msg.type!=="mri-get-data"&&msg.type!=="mri-content-ready")res={ok:false,error:"合成 storage 写入失败"};
          else if(msg.type==="mri-get-data")res={ok:true,records:previewRecords,stats:previewStats,settings:{floatingEnabled:floatingEnabled}};
          else if(msg.type==="mri-set-floating"){floatingEnabled=msg.enabled;res={ok:true};}
          else if(msg.type==="mri-export-json")res={ok:true,json:JSON.stringify(previewRecords)};
          else if(msg.type==="mri-export-csv")res={ok:true,csv:"requestId,status\\\\n"+previewRecords.map(function(r){return r.requestId+","+r.status}).join("\\\\n")};
          else res={ok:true};
          setTimeout(function(){if(cb)cb(res)},0);
        },
        onMessage:{addListener:function(fn){window.previewMessageHandler=fn}}
      },
      tabs:{
        query:function(q,cb){cb([{id:1,url:"https://chatgpt.com/"}])},
        sendMessage:function(id,msg,cb){cb({ok:true,diag:{version:3,hookInstalled:true,fetchCalls:12,candidates:4,matched:1,records:1,lastGeneration:{endpoint:"/backend-api/f/conversation",status:200,transport:"sse",hasResolved:true,hasServerSte:true,requestedModel:"gpt-6-thinking",resolvedModel:"gpt-6-thinking",serverModel:"gpt-6-thinking",judgment:"match",chunks:14,events:22},lastObserved:{endpoint:"/backend-api/conversation/prepare",status:200,matched:false,transport:null},unknownMetaKeys:["opaque_scheduler_hint"]}})}
      }
    };
  </script>`;
}
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(!baseline && ['/baseline','/baseline.js','/baseline.css'].includes(u.pathname)) {
    res.writeHead(503,{'Content-Type':'text/plain;charset=utf-8'});
    res.end('Original a3f2 baseline is unavailable. No substitute comparison is shown.');return;
  }
  if(u.pathname==='/intrinsic' || u.pathname==='/responsive') {
    res.setHeader('Content-Type','text/html;charset=utf-8');
    // Emulates an auto-sized surface beginning at 200px, without a 490px viewport override.
    // This checks the document's sizing contract, not Chrome's actual popup host.
    const autoSize=u.pathname==='/intrinsic', width=u.searchParams.get('width')==='360' ? 360 : 200;
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>合成弹窗尺寸检查</title>
      <style>body{margin:16px;background:#eef2f7;font:14px Microsoft YaHei}iframe{border:0;width:${width}px;height:600px;display:block}p{margin:0 0 10px}output{display:block;max-width:750px;font:10px monospace;overflow-wrap:anywhere}</style>
      <p>${autoSize ? '合成自动尺寸宿主：从 200px 读取文档最小宽度后调节' : '普通网页固定窄视窗响应检查'}；不是已安装扩展。</p>
      <output id="sizing-result">检查中</output>
      <iframe title="合成扩展弹窗" src="/popup?${autoSize ? 'surface=extension&count=1000' : 'count=6'}"></iframe>
      <script>document.querySelector('iframe').addEventListener('load',function(){
        const frame=this,doc=frame.contentDocument;
        const initial={viewport:frame.clientWidth,document:doc.documentElement.scrollWidth,minWidth:getComputedStyle(doc.documentElement).minWidth};
        if(${autoSize}) frame.style.width=doc.documentElement.scrollWidth+'px';
        requestAnimationFrame(function(){
          const panel=doc.querySelector('.tab-panel.active');
          const nested=Array.from(panel.querySelectorAll('*')).filter(function(el){const s=getComputedStyle(el);return /auto|scroll/.test(s.overflowY)&&el.scrollHeight>el.clientHeight;});
          const result={initial:initial,final:{width:frame.clientWidth,height:frame.clientHeight,documentWidth:doc.documentElement.scrollWidth,rootScrolls:doc.documentElement.scrollHeight>doc.documentElement.clientHeight,bodyScrolls:doc.body.scrollHeight>doc.body.clientHeight,panelScrolls:panel.scrollHeight>panel.clientHeight,nestedScrollers:nested.length,horizontalOverflow:panel.scrollWidth>panel.clientWidth}};
          result.checks={intrinsicWidth:${autoSize} ? initial.document>=400&&initial.document<=800 : initial.document===${width},finalWidth:result.final.width===${autoSize ? 490 : width},heightWithinChromeLimit:result.final.height<=600,singleScroller:!result.final.rootScrolls&&!result.final.bodyScrolls&&result.final.panelScrolls&&result.final.nestedScrollers===0,noHorizontalOverflow:!result.final.horizontalOverflow};
          result.passed=Object.values(result.checks).every(Boolean);
          document.getElementById('sizing-result').textContent=JSON.stringify(result);
        });
      });</script></html>`);return;
  }
  if(u.pathname==='/popup' || u.pathname==='/baseline') {
    res.setHeader('Content-Type','text/html;charset=utf-8');
    const html=u.pathname==='/baseline' ? baseline['popup.html'].replace('href="popup.css"','href="baseline.css"').replace('src="popup.js"','src="baseline.js"') : fs.readFileSync(path.join(src,'popup.html'),'utf8');
    const surface=u.searchParams.get('surface')==='extension' ? html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-surface="extension-popup">') : html;
    res.end(surface.replace('</head>',bootstrap(u.searchParams.has('fail'),Math.min(1000,Math.max(6,Number(u.searchParams.get('count') || 6))))+'</head>'));return;
  }
  if(u.pathname==='/card') {
    const idx=Number(u.searchParams.get('case') || 0);
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>悬浮卡合成验收</title><style>body{font:14px Microsoft YaHei;background:#eef2f7;color:#354055;padding:30px}h1{font-size:20px}a{margin-right:12px}</style>'+bootstrap(u.searchParams.has('fail'))+'<h1>本地悬浮卡 · 合成元数据</h1><p>仅使用合成记录，未读取真实聊天。</p><p><a href="/card?case=0">已完成后传输取消</a><a href="/card?case=1">停止且无完成标志</a><a href="/card?case=2">长模型名</a><a href="/card?case=3">观察器受限</a><a href="/card?case=5">缺失字段</a></p><script src="/content.js"></script><script>window.postMessage({source:"mri",type:"record",record:previewRecords['+idx+']},location.origin);</script></html>');return;
  }
  if(u.pathname==='/inline') {
    const dark=u.searchParams.has('dark'),bottom=u.searchParams.has('bottom');
    res.setHeader('Content-Type','text/html;charset=utf-8');
    const inlineRecords=records.slice(0,4).map((r,i)=>({...r,requestId:'inline-'+i,inputMessageIds:['input-'+i],assistantMessageIds:['assistant-'+i],messageId:'assistant-'+i,thinkingEffort:i===3 || i===1 ? null : 'max',requestedThinkingEffort:null,firstTokenMs:i===3 ? null : 2150.4,totalMs:i===3 ? null : 9340.7,toolEvidence:i===0 ? 'observed' : 'not_observed',toolCalls:i===0 ? [{name:'web.run',count:null,status:'observed',durationMs:null},{name:'SonicBrowserTool',count:2,status:'completed',durationMs:1370}] : []}));
    const bottomCss=bottom ? 'body{overflow:hidden}.page{height:100vh;overflow:auto;margin:0 auto;padding-top:calc(100vh - 286px);padding-bottom:160px}.page header{display:none}[data-turn-key]:not([data-turn-key="input-0"]){display:none}[data-thread-scroll-footer]{position:fixed;left:0;right:0;bottom:0;height:76px;background:'+ (dark ? '#212121' : '#fff')+';z-index:20;display:flex;align-items:center;justify-content:center}[data-composer-body]{padding:8px 16px;border:1px solid '+(dark ? '#555' : '#ccc')+';border-radius:18px;background:'+(dark ? '#303030' : '#f6f6f6')+';min-width:min(60vw,600px)}' : '';
    const bottomFooter=bottom ? '<div data-thread-scroll-footer><form data-chatgpt-composer><div data-composer-body>合成输入区遮挡面 · 实际结构投影</div></form></div>' : '';
    const regenerationPreview=`<script>var regenerationFixture=${JSON.stringify(require('./fixtures/inline-regeneration-2026-10-08.json'))};var regenerateButton=document.querySelector('[data-turn-key="input-0"] [data-talvt-turn-state] button[aria-label="重新生成"]');regenerateButton.textContent='↻';regenerateButton.title='模拟messages为空的variant重生成';regenerateButton.setAttribute('aria-label','模拟重生成');regenerateButton.addEventListener('click',function(){regenerateButton.disabled=true;var state=regenerateButton.closest('[data-talvt-turn-state]');inlineController.requestContext(Object.assign({},regenerationFixture.context,{requestedParentMessageId:'input-0'}));state.setAttribute('data-talvt-turn-state','in_progress');setTimeout(function(){inlineController.accept(Object.assign({},regenerationFixture.record,{requestedParentMessageId:'input-0'}));state.setAttribute('data-talvt-turn-state','complete');regenerateButton.disabled=false;},1200);});</script>`;
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>每回复底部 · 合成UI</title><style>:root{color-scheme:${dark ? 'dark' : 'light'}}*{box-sizing:border-box}body{margin:0;background:${dark ? '#212121' : '#fff'};color:${dark ? '#e6e6e6' : '#262626'};font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}.page{max-width:820px;margin:25px auto;padding:0 24px}h1{font-size:18px}header p{color:${dark ? '#aaa' : '#777'};font-size:12px}.turn{padding:18px 0;border-bottom:1px solid ${dark ? '#3c3c3c' : '#eee'}}.turn p{margin:0 0 12px}.turn-action-controls{display:flex;align-items:center;gap:6px;min-height:32px}.host-actions{display:flex;flex-shrink:0;align-items:center;gap:4px}.host-actions button{border:0;background:transparent;color:${dark ? '#aaa' : '#888'};font-size:16px;min-width:24px;padding:1px;cursor:pointer}a{color:#6597c6}${bottomCss}</style><main class="page" data-app-action-timeline-scroll><header><h1>每回复底部 · 合成 UI 预览</h1><p>与当前 ChatGPT 的 data-turn-key / turn-action-controls 结构相同。记录与正文均为合成；不是已安装扩展或真实降级证据。</p><p><a href="/inline">浅色</a> · <a href="/inline?dark">深色</a> · <a href="/inline?dark&bottom">贴底遮挡投影</a></p></header>${inlineRecords.map((r,i)=>inlineTurnMarkup('input-'+i,['这是一段合成回复。工具内容包含已观察的名称和次数未知的独立状态。','这段合成回复演示停止生成后的模型与客户端耗时。','这段合成回复演示长模型名称与路由切换。','这段合成回复演示没有实际模型或思考强度证据。'][i])).join('')}${inlineTurnMarkup('regenerated','同一输入的两次生成无法由此 DOM 确认当前分支。')}</main>${bottomFooter}<script src="/inline-ui.js"></script><script>var inlineController=MRIInline.createController({document:document,window:window});${JSON.stringify(inlineRecords)}.forEach(function(r){inlineController.accept(r)});inlineController.accept({requestId:'regen-1',inputMessageIds:['regenerated'],status:'match',serverModel:'gpt-6'});inlineController.accept({requestId:'regen-2',inputMessageIds:['regenerated'],status:'match',serverModel:'gpt-6'});</script>${regenerationPreview}</html>`);return;
  }
  const name=u.pathname.slice(1);
  if(name==='baseline.js'||name==='baseline.css'){res.setHeader('Content-Type',name.endsWith('.css')?'text/css;charset=utf-8':'text/javascript;charset=utf-8');res.end(baseline[name.replace('baseline','popup')]);return;}
  if(!['popup.js','popup.css','content.js','inline-ui.js'].includes(name)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',name.endsWith('.css')?'text/css;charset=utf-8':'text/javascript;charset=utf-8');res.end(fs.readFileSync(path.join(src,name)));
}).listen(4173,'127.0.0.1',()=>console.log('Synthetic UI preview http://127.0.0.1:4173/popup and /card'));

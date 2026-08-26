/*
 * test/regression-test.js
 * 用真实字段结构的 fixture 做回归：确保所有已知字段都能提取，
 * 敏感字段不落盘，未知 metadata key 被诊断捕获。
 *
 * 运行：node test/regression-test.js
 */
const path = require('path');
const parser = require(path.join(__dirname, '..', 'src', 'parser.js'));
const detector = require(path.join(__dirname, '..', 'src', 'detector.js'));
const fixture = require(path.join(__dirname, 'fixtures', 'real-conversation.js'));

let passed = 0, failed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('\n== regression: real /f/conversation fixture ==');

// 用 1 字符 chunk 喂入，模拟极端分片
const sse = fixture.sse;
const rec = detector.createRecord('reg', 'https://chatgpt.com/backend-api/f/conversation');
rec.requestedModel = fixture.requestedModel;
rec.endpoint = '/backend-api/f/conversation';
rec.transport = 'sse';

const unknownKeys = [];
const diag = { addUnknownMetaKey: function (k) { unknownKeys.push(k); } };
let markerCount = 0;

const p = parser.createParser(function (ev) {
  if (ev.done || ev.parseError) return;
  if (ev.data && typeof ev.data === 'object') {
    if (detector.isGenerationEvent(ev.data)) markerCount++;
    detector.extractFields(ev.data, rec, diag);
  }
});
for (let i = 0; i < sse.length; i++) p.feed(sse[i]);
p.end();
detector.finalizeTiming(rec);
detector.judge(rec);

const exp = fixture.expected;

// 1) generation 特征识别
assert(markerCount >= 3, 'generation markers detected (got ' + markerCount + ')');

// 2) 路由字段
assert(rec.status === 'match', 'status=match (' + rec.status + ')');
assert(rec.requestedModel === exp.requestedModel, 'requestedModel');
assert(rec.resolvedModel === exp.resolvedModel, 'resolvedModel');
assert(rec.serverModel === exp.serverModel, 'serverModel');
assert(rec.defaultModel === exp.defaultModel, 'defaultModel');
assert(rec.messageModel === exp.messageModel, 'messageModel');
assert(rec.modelSlug === 'gpt-5-6-thinking', 'modelSlug');

// 3) 模式
assert(rec.requestedExperience === exp.requestedExperience, 'requestedExperience');
assert(rec.thinkingEffort === exp.thinkingEffort, 'thinkingEffort');
assert(rec.productExperience === exp.productExperience, 'productExperience');
assert(rec.turnMode === exp.turnMode, 'turnMode');
assert(rec.turnUseCase === exp.turnUseCase, 'turnUseCase');

// 4) 自动切换器
assert(rec.isAutoswitcherEnabled === false, 'isAutoswitcherEnabled=false');
assert(rec.didAutoSwitchToReasoning === false, 'didAutoSwitchToReasoning=false');
assert(rec.autoSwitcherRaceWinner === null, 'autoSwitcherRaceWinner=null');
assert(Array.isArray(rec.modelSwitcherDeny) && rec.modelSwitcherDeny.length === 0, 'modelSwitcherDeny=[]');

// 5) 服务端调度
assert(rec.fastConvo === true, 'fastConvo=true');
assert(rec.warmupState === 'rewarm', 'warmupState=rewarm');
assert(rec.conduitPrewarmed === false, 'conduitPrewarmed=false');
assert(rec.isFirstTurn === false, 'isFirstTurn=false');

// 6) 账户
assert(rec.planType === 'plus', 'planType=plus');
assert(rec.planTypeBucket === 'paid', 'planTypeBucket=paid');

// 7) 基础设施
assert(rec.clusterRegion === 'japaneast', 'clusterRegion=japaneast');
assert(rec.serverTtfvt === 1644.749, 'serverTtfvt=1644.749');

// 8) 传输
assert(rec.transport === 'sse', 'transport=sse');
assert(rec.resumeWithWebsockets === true, 'resumeWithWebsockets=true');

// 9) 任务类型
assert(rec.toolInvoked === false, 'toolInvoked=false');
assert(rec.isSearch === null, 'isSearch=null');
assert(rec.isMultimodal === null, 'isMultimodal=null');
assert(rec.didPromptContainImage === false, 'didPromptContainImage=false');

// 10) 追踪 ID
assert(rec.conversationId === exp.conversationId, 'conversationId');
assert(rec.messageId === exp.messageId, 'messageId');
assert(rec.serverRequestId === exp.serverRequestId, 'serverRequestId');
assert(rec.turnExchangeId === exp.turnExchangeId, 'turnExchangeId');
assert(rec.turnTraceId === exp.turnTraceId, 'turnTraceId');

// 11) 时间
assert(rec.reasoningStartTime === exp.reasoningStartTime, 'reasoningStartTime');
assert(rec.reasoningEndTime === exp.reasoningEndTime, 'reasoningEndTime');
assert(rec.reasoningDurationMs === Math.round((exp.reasoningEndTime - exp.reasoningStartTime) * 1000),
  'reasoningDurationMs computed (' + rec.reasoningDurationMs + ')');

// 12) 隐私：敏感 token 绝不能出现在记录里
const recJson = JSON.stringify(rec);
assert(recJson.indexOf('FAKE.SENSITIVE.TOKEN') === -1, 'resume_conversation_token VALUE not stored');
assert(recJson.indexOf('FAKE_ASSISTANT_TEXT') === -1, 'assistant text not stored');
assert(recJson.indexOf('resume_conversation_token') === -1, 'resume_conversation_token KEY not stored');

// 13) 未知 metadata key 被诊断捕获，但不进入记录字段
assert(unknownKeys.indexOf('a32e6ebcb') !== -1, 'unknown meta key "a32e6ebcb" reported to diagnostics');
assert(rec.a32e6ebcb === undefined, 'unknown meta key not written to record');

// 14) fieldSources 记录了证据来源
assert(rec.fieldSources.serverModel === 'metadata.model_slug', 'fieldSources.serverModel path');
assert(rec.fieldSources.clusterRegion === 'metadata.cluster_region', 'fieldSources.clusterRegion path');

// 15) /f/conversation mismatch 场景
(function () {
  const mismatchSSE = [
    { type: 'response_created', resolved_model_slug: 'gpt-5-5-mini', default_model_slug: 'gpt-5-5-mini' },
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-5-mini' } },
    { type: 'message_stream_complete' }
  ].map(function (e) { return 'data: ' + JSON.stringify(e) + '\n\n'; }).join('') + 'data: [DONE]\n\n';

  const r2 = detector.createRecord('r2', 'https://chatgpt.com/backend-api/f/conversation');
  r2.requestedModel = 'gpt-5-6-thinking';
  const p2 = parser.createParser(function (ev) {
    if (!ev.done && !ev.parseError && ev.data && typeof ev.data === 'object') {
      detector.extractFields(ev.data, r2);
    }
  });
  for (let i = 0; i < mismatchSSE.length; i += 2) p2.feed(mismatchSSE.slice(i, i + 2));
  p2.end();
  detector.judge(r2);
  assert(r2.status === 'mismatch', '/f/conversation 5.6 -> 5.5-mini = mismatch (' + r2.status + ')');
})();

console.log('\n----------------------------------------');
console.log('REGRESSION PASSED: ' + passed + '   FAILED: ' + failed);
console.log('----------------------------------------\n');
process.exit(failed ? 1 : 0);

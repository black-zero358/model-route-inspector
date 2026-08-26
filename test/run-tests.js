/*
 * test/run-tests.js — parser.js + detector.js 单元测试
 * 运行：node test/run-tests.js
 */
const path = require('path');
const parser = require(path.join(__dirname, '..', 'src', 'parser.js'));
const detector = require(path.join(__dirname, '..', 'src', 'detector.js'));

let passed = 0;
let failed = 0;

function assert(cond, name, extra) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

function feedByChunks(str, chunkSize) {
  const events = [];
  const p = parser.createParser(function (ev) { events.push(ev); });
  for (let i = 0; i < str.length; i += chunkSize) {
    p.feed(str.slice(i, i + chunkSize));
  }
  p.end();
  return events;
}

console.log('\n== parser.js ==');

// 1) 正常单事件
(function () {
  const s = 'event: delta\ndata: {"type":"delta","v":1}\n\n';
  const evs = feedByChunks(s, 1024);
  assert(evs.length === 1, 'single event parsed');
  assert(evs[0].event === 'delta', 'event type preserved');
  assert(evs[0].data.type === 'delta' && evs[0].data.v === 1, 'json parsed');
})();

// 2) 极小 chunk（每次 1 字符）
(function () {
  const s = 'event: delta\ndata: {"type":"delta","model_slug":"gpt-5-6-thinking"}\n\n' +
            'data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-5-6-thinking"}}\n\n' +
            'data: [DONE]\n\n';
  const evs = feedByChunks(s, 1);
  assert(evs.length === 3, '1-char chunks: 3 events (got ' + evs.length + ')');
  assert(evs[0].data.model_slug === 'gpt-5-6-thinking', '1-char chunks: json intact');
  assert(evs[1].data.metadata.model_slug === 'gpt-5-6-thinking', '1-char chunks: metadata intact');
  assert(evs[2].done === true, '1-char chunks: [DONE]');
})();

// 3) 一个 chunk 多条事件
(function () {
  const s = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3}\n\n';
  const evs = feedByChunks(s, 1024);
  assert(evs.length === 3, 'multi-event chunk: 3 events');
  assert(evs[0].data.a === 1 && evs[2].data.a === 3, 'multi-event chunk: order');
})();

// 4) event: 和 data: 分开，多行 data
(function () {
  const s = 'event: some_event\ndata: {"line":1,\ndata: "line":2}\n\n';
  const evs = feedByChunks(s, 1024);
  assert(evs.length === 1, 'multi-line data: 1 event');
  assert(evs[0].event === 'some_event', 'event name');
  assert(evs[0].data.line === 2, 'multi-line data joined (last wins in JSON)');
})();

// 5) CRLF
(function () {
  const s = 'event: delta\r\ndata: {"x":42}\r\n\r\n';
  const evs = feedByChunks(s, 1024);
  assert(evs.length === 1 && evs[0].data.x === 42, 'CRLF line endings');
})();

// 6) malformed JSON 不抛异常
(function () {
  const s = 'data: not-json\n\ndata: {"ok":true}\n\n';
  let threw = false;
  let evs;
  try { evs = feedByChunks(s, 1024); } catch (e) { threw = true; }
  assert(!threw, 'malformed JSON does not throw');
  assert(evs.length === 2, 'malformed: still 2 events');
  assert(evs[0].parseError === true, 'malformed flagged');
  assert(evs[1].data.ok === true, 'valid event after malformed');
})();

// 7) 注释行 & 末尾无空行
(function () {
  const s = ': ping\ndata: {"tail":true}\n';
  const evs = feedByChunks(s, 1024);
  assert(evs.length === 1 && evs[0].data.tail === true, 'comment ignored + final flush without blank line');
})();

// 8) 未知字段/未来协议不崩
(function () {
  const s = 'data: {"type":"future_thing","totally_new_field":{"nested":[1,2,3]}}\n\n';
  let threw = false;
  try { feedByChunks(s, 3); } catch (e) { threw = true; }
  assert(!threw, 'unknown future fields do not crash parser');
})();

console.log('\n== detector.js ==');

function runStream(events, requestedModel) {
  const rec = detector.createRecord('test', 'https://chatgpt.com/backend-api/conversation');
  rec.requestedModel = requestedModel;
  events.forEach(function (e) { detector.extractFields(e, rec); });
  return detector.judge(rec);
}

// 9) match：请求=resolved=server
(function () {
  const rec = runStream([
    { model_slug: 'gpt-5-6-thinking', resolved_model_slug: 'gpt-5-6-thinking', default_model_slug: 'gpt-5-5-mini' },
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-6-thinking', cluster_region: 'us-east-1', server_ttfvt_ms: 320 } },
    { conversation_id: 'conv-1', message_id: 'msg-1' },
    { requested_model_experience: 'standard', thinking_effort: 'extended', did_auto_switch_to_reasoning: false }
  ], 'gpt-5-6-thinking');
  assert(rec.status === 'match', 'match when requested=resolved=server (' + rec.status + ')');
  assert(rec.serverModel === 'gpt-5-6-thinking', 'serverModel extracted');
  assert(rec.resolvedModel === 'gpt-5-6-thinking', 'resolvedModel extracted');
  assert(rec.defaultModel === 'gpt-5-5-mini', 'defaultModel extracted');
  assert(rec.clusterRegion === 'us-east-1', 'clusterRegion extracted');
  assert(rec.serverTtfvt === 320, 'serverTtfvt extracted');
  assert(rec.conversationId === 'conv-1' && rec.messageId === 'msg-1', 'ids extracted');
  assert(rec.thinkingEffort === 'extended', 'thinkingEffort extracted');
  assert(rec.didAutoSwitchToReasoning === false, 'didAutoSwitchToReasoning extracted');
})();

// 10) 关键验收：requested=5.6, resolved=5.5-mini, server=5.5-mini => mismatch
(function () {
  const rec = runStream([
    { resolved_model_slug: 'gpt-5-5-mini' },
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-5-mini' } }
  ], 'gpt-5-6-thinking');
  assert(rec.status === 'mismatch', 'mismatch when 5.6 -> 5.5-mini (' + rec.status + ')');
  assert(/切换|降级/.test(rec.reason), 'mismatch reason mentions switch');
})();

// 11) 缺少 resolved 字段不能误判降级（server 与请求一致 => match）
(function () {
  const rec = runStream([
    { model_slug: 'gpt-5-6-thinking' },
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-6-thinking' } }
  ], 'gpt-5-6-thinking');
  assert(rec.status === 'match', 'no false mismatch when resolved missing but server matches (' + rec.status + ')');
})();

// 12) resolved 和 server 冲突 => conflict
(function () {
  const rec = runStream([
    { resolved_model_slug: 'gpt-5-6-thinking' },
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-5-mini' } }
  ], 'gpt-5-6-thinking');
  assert(rec.status === 'conflict', 'conflict when resolved != server (' + rec.status + ')');
  assert(rec.conflict === true, 'conflict flag set');
})();

// 13) 完全没有服务端字段 => unknown（不喊降级）
(function () {
  const rec = runStream([
    { some_other: 'data' }
  ], 'gpt-5-6-thinking');
  assert(rec.status === 'unknown', 'unknown when no server/resolved fields (' + rec.status + ')');
})();

// 14) 连请求模型都没有但有 server => unknown
(function () {
  const rec = runStream([
    { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-6-thinking' } }
  ], null);
  assert(rec.status === 'unknown', 'unknown when requested missing (' + rec.status + ')');
})();

// 15) 多轮隔离：两个 record 互不串数据
(function () {
  const r1 = detector.createRecord('a');
  r1.requestedModel = 'gpt-5-6-thinking';
  detector.extractFields({ resolved_model_slug: 'gpt-5-6-thinking', conversation_id: 'conv-A' }, r1);
  detector.judge(r1);

  const r2 = detector.createRecord('b');
  r2.requestedModel = 'gpt-5-6-thinking';
  detector.extractFields({ resolved_model_slug: 'gpt-5-5-mini', conversation_id: 'conv-B' }, r2);
  detector.judge(r2);

  assert(r1.status === 'match' && r1.conversationId === 'conv-A', 'round 1 isolated');
  assert(r2.status === 'mismatch' && r2.conversationId === 'conv-B', 'round 2 isolated');
})();

// 16) 嵌套 message.id 兜底
(function () {
  const rec = detector.createRecord('c');
  detector.extractFields({ type: 'response_created', message: { id: 'msg-nested', conversation_id: 'conv-nested' } }, rec);
  assert(rec.messageId === 'msg-nested' && rec.conversationId === 'conv-nested', 'nested message.id fallback');
})();

// 17) prettyModel / shortBadge
(function () {
  assert(detector.prettyModel('gpt-5-6-thinking') === '5.6 Thinking', 'prettyModel thinking');
  assert(detector.prettyModel('gpt-5-5-mini') === '5.5 Mini', 'prettyModel mini');
  assert(detector.shortBadge('gpt-5-6-thinking') === '5.6', 'shortBadge thinking = 5.6');
  assert(detector.shortBadge('gpt-5-5-mini') === '5.5m', 'shortBadge mini = 5.5m');
})();

// 18) 完整模拟流 + 1 字符 chunk 喂入 extractor
(function () {
  const stream = [
    'event: delta',
    'data: {"model_slug":"gpt-5-6-thinking","resolved_model_slug":"gpt-5-5-mini","default_model_slug":"gpt-5-5-mini","conversation_id":"c1","message_id":"m1"}',
    '',
    'event: delta',
    'data: {"type":"server_ste_metadata","metadata":{"model_slug":"gpt-5-5-mini","cluster_region":"eu-west","server_ttfvt_ms":150}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const rec = detector.createRecord('full');
  rec.requestedModel = 'gpt-5-6-thinking';
  const p = parser.createParser(function (ev) {
    if (!ev.done && !ev.parseError && ev.data && typeof ev.data === 'object') {
      detector.extractFields(ev.data, rec);
    }
  });
  for (let i = 0; i < stream.length; i++) p.feed(stream[i]);
  p.end();
  detector.judge(rec);
  assert(rec.status === 'mismatch', 'full simulated stream -> mismatch (' + rec.status + ')');
  assert(rec.serverModel === 'gpt-5-5-mini' && rec.clusterRegion === 'eu-west' && rec.serverTtfvt === 150, 'full stream fields');
})();

// 19) generation 特征识别
(function () {
  assert(detector.isGenerationEvent({ type: 'server_ste_metadata', metadata: {} }) === true, 'marker: server_ste_metadata');
  assert(detector.isGenerationEvent({ type: 'message_stream_complete' }) === true, 'marker: message_stream_complete');
  assert(detector.isGenerationEvent({ delta_encoding: 'roles' }) === true, 'marker: delta_encoding key');
  assert(detector.isGenerationEvent({ type: 'delta', delta: {} }) === false, 'non-marker delta alone');
  assert(detector.isGenerationEvent({ foo: 'bar' }) === false, 'plain object not a marker');
})();

// 20) 敏感字段不被提取
(function () {
  const rec = detector.createRecord('sens');
  detector.extractFields({
    type: 'server_ste_metadata',
    metadata: { model_slug: 'gpt-5', resume_conversation_token: 'SECRET', access_token: 'X' }
  }, rec);
  const j = JSON.stringify(rec);
  assert(rec.serverModel === 'gpt-5', 'sensitive test: model still extracted');
  assert(j.indexOf('SECRET') === -1 && j.indexOf('access_token') === -1, 'sensitive keys/values not stored');
})();

console.log('\n----------------------------------------');
console.log('PASSED: ' + passed + '   FAILED: ' + failed);
console.log('----------------------------------------\n');
process.exit(failed ? 1 : 0);

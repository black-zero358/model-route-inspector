/* Core observer regressions. Synthetic body text only; no browser profile data. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const detector = require('../src/detector');
const { createParser } = require('../src/parser');
const sourceRoot = path.resolve(__dirname, '../src');
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await wait(5); } throw new Error('Timed out waiting for synthetic observer'); }
const generation = [
  { v: { message: { author: { role: 'assistant' }, channel: 'analysis', content: { parts: ['synthetic reasoning'] }, metadata: { resolved_model_slug: 'gpt-6' } } } },
  { o: 'patch', v: [{ p: '/message/channel', o: 'replace', v: 'final' }, { p: '/message/content/parts/0', o: 'append', v: 'synthetic answer' }] },
  { type: 'server_ste_metadata', metadata: { model_slug: 'gpt-6', region: null, requested_model_experience: 'instant' } },
  { type: 'message_stream_complete' }
];
const toSSE = events => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
const sse = events => new Response(toSSE(events), { headers: { 'content-type': 'text/event-stream' } });
function harness(fetch, extra = {}) {
  const messages = [], listeners = [];
  const context = { console, URL, Date, Math, JSON, Object, Array, String, Number, Boolean,
    Set, Promise, Error, Request, Response, TextDecoder, ReadableStream, performance,
    setTimeout, clearTimeout, setImmediate,
    location: { href: 'https://chatgpt.com/?private=synthetic#sensitive', origin: 'https://chatgpt.com' },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); }, fetch, ...extra };
  context.window = context;
  vm.createContext(context);
  const global = vm.runInContext('globalThis', context);
  context.postMessage = data => { messages.push(data); setImmediate(() => listeners.slice().forEach(fn => fn({ source: global, data }))); };
  for (const file of ['parser.js', 'detector.js', 'injected.js']) vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), context, { filename: file });
  return { context, messages, records: () => messages.filter(item => item.type === 'record').map(item => item.record),
    diag: async () => { context.postMessage({ source: 'mri', type: 'diag-request', requestId: 'synthetic_diag' }); await until(() => messages.some(item => item.type === 'diag')); return messages.filter(item => item.type === 'diag').at(-1); } };
}
async function consume(h, input = '/backend-api/f/conversation', init) {
  if (arguments.length < 3) init = { method: 'POST', body: '{"model":"gpt-6"}' };
  const response = await h.context.fetch(input, init);
  await response.text().catch(() => {});
  await until(() => h.records().length);
  return h.records()[0];
}
(async () => {
  {
    const evs = [], parser = createParser(event => evs.push(event));
    parser.feed('\uFEFFdata: {"a":1}\r'); parser.feed('\ndata: {"b":2}\r\rdata: [DONE]'); parser.end(); parser.end();
    check('BOM/CR/chunked CRLF recovery and idempotent end', evs.length === 2 && evs[0].parseError && evs[1].done && evs[1].unterminated);
    const tail = []; const p = createParser(event => tail.push(event)); p.feed('data: {"model_slug":"gpt-6"}'); p.end();
    check('newline-free tail recovered with explicit unterminated evidence', tail.length === 1 && tail[0].data.model_slug === 'gpt-6' && tail[0].unterminated);
    let callbacks = 0; const isolated = createParser(() => { callbacks++; throw new Error('synthetic callback failure'); });
    isolated.feed('data: {}\n\ndata: {}\n\n');
    check('callback exceptions isolated without duplicate parse errors', callbacks === 2);
    const malformed = []; const bad = createParser(event => malformed.push(event)); bad.feed('data: private-synthetic-body\n\n');
    check('malformed events retain no raw data or parser message containing body', !JSON.stringify(malformed).includes('private-synthetic-body') && !('data' in malformed[0]));
    const capped = []; const cap = createParser(event => capped.push(event), { maxEventChars: 64 });
    for (let i = 0; i < 1000; i++) cap.feed('xxxxxxxxxx');
    cap.feed('\n\ndata: {"ok":true}\n\n');
    check('oversized single line bounded and next event recovers', capped.length === 2 && capped[0].limitExceeded && capped[1].data.ok);
    const multi = []; const pm = createParser(event => multi.push(event), { maxEventChars: 64 });
    pm.feed('data: "' + 'x'.repeat(25) + '\ndata: ' + 'x'.repeat(25) + '\ndata: ' + 'x'.repeat(25) + '"\n\ndata: {}\n\n');
    check('multiline event limit resynchronizes correctly', multi[0].limitExceeded && multi.at(-1).data && Object.keys(multi.at(-1).data).length === 0);
    const boundary = []; const pb = createParser(event => boundary.push(event), { maxEventChars: 8 });
    pb.feed('data: 12345678\n\ndata: {}\n\n');
    check('exact event boundary overflow recovers on next blank line', boundary.length === 2 && boundary[0].limitExceeded && boundary[1].data);
  }
  {
    const rec = detector.createRecord('synthetic'), state = {}, unknown = {};
    detector.extractFields({ message: { author: { role: 'user' }, metadata: { resolved_model_slug: 'spoof' }, content: { parts: [{ model_slug: 'spoof' }] } } }, rec, null, state);
    check('user message metadata/body cannot spoof route fields', !rec.resolvedModel && !rec.modelSlug);
    detector.extractFields({ v: { message: { author: { role: 'assistant' }, channel: 'analysis', content: { parts: [] }, metadata: { model_slug: 'gpt-6', resolved_model_slug: 'gpt-6' } } } }, rec, null, state);
    const summary = detector.extractFields({ v: [{ p: '/message/content/parts/0', o: 'append', v: 'synthetic' }, { p: '/message/metadata/thinking_effort', o: 'replace', v: 'max' }] }, rec, null, state);
    check('nested assistant metadata and batch patch extraction', rec.messageModel === 'gpt-6' && rec.resolvedModel === 'gpt-6' && rec.thinkingEffort === 'max');
    check('reasoning and final answer text classified independently', summary.reasoning && !summary.text);
    const final = detector.extractFields({ v: [{ p: '/message/channel', o: 'replace', v: 'final' }, { p: '/message/content/parts/0', o: 'append', v: 'synthetic' }] }, rec, null, state);
    check('channel patch updates subsequent answer timing classification', final.text && !final.reasoning);
    detector.extractFields({ type: 'server_ste_metadata', metadata: { model_slug: 'gpt-6', region: null, tool_name: '', is_search: false, search_tool_call_count: 0,
      requested_model_experience: 'thinking', user_agent: 'synthetic private', authorization: 'synthetic private', new_schedule: { secret: 'synthetic private' }, auto_switcher_race_winner: { content: 'synthetic private' } } }, rec, { addUnknownMetaKey: (key, type) => { unknown[key] = type; } }, state);
    check('null/empty/false/zero have distinct field evidence', rec.fieldStates.region === 'null' && rec.fieldStates.toolName === 'empty' && rec.isSearch === false && rec.searchToolCallCount === 0);
    check('known experience correctly classified and unknown keys retain type only', !unknown.requested_model_experience && unknown.new_schedule === 'object' && !unknown.user_agent && !unknown.authorization);
    check('opaque known object rejected without secret retention', rec.fieldStates.autoSwitcherRaceWinner === 'invalid' && !JSON.stringify(rec).includes('synthetic private'));
    detector.extractFields({ type: 'server_ste_metadata', metadata: { model_slug: null, region: 'west' } }, rec);
    check('later null cannot erase prior model evidence', rec.serverModel === 'gpt-6' && rec.fieldStates.serverModel === 'value');
    check('safe model metadata sources retained', rec.fieldSources.thinkingEffort === 'v[1].v');
    const nested = {}; let cursor = nested;
    for (let i = 0; i < 30; i++) { cursor.v = {}; cursor = cursor.v; }
    cursor.resolved_model_slug = 'not-observed';
    check('protocol traversal has explicit depth limit', detector.extractFields(nested, rec).limited && rec.resolvedModel === 'gpt-6');
    let partVisits = 0;
    const heavy = { message: { author: { role: 'assistant' }, content: { parts: Array.from({ length: 20000 }, () => new Proxy({ model_slug: 'synthetic' }, { ownKeys: target => { partVisits++; return Reflect.ownKeys(target); } })) }, metadata: { resolved_model_slug: 'gpt-6' } } };
    const started = performance.now();
    for (let i = 0; i < 100; i++) detector.extractFields(heavy, detector.createRecord('perf'));
    console.log('CONTROLLED metadata walk: 100 events with 20,000 content objects each; elapsedMs=' + Math.round(performance.now() - started) + ', content object enumerations=' + partVisits);
    check('metadata extraction cost does not enumerate content object trees', partVisits === 0);
  }
  {
    const { cases } = require('./fixtures/compatibility-2026-10-08.json');
    assert.equal(cases.length, 6, 'all six observed compatibility scenarios travel with the repository');
    for (const evidence of cases) {
      const rec = detector.createRecord('replay'), state = {};
      evidence.fixtures.forEach(event => detector.extractFields(event, rec, null, state));
      check('filtered online structure preserves route: ' + evidence.label, rec.resolvedModel === evidence.expected.resolvedModel && rec.serverModel === evidence.expected.serverModel);
      if (evidence.expected.messageModel) check('filtered online message model captured: ' + evidence.label, rec.messageModel === evidence.expected.messageModel);
    }
  }
  {
    let wall = 100000;
    class ClockDate extends Date { static now() { return wall; } }
    const h = harness(async () => { await wait(65); wall = 90000; return sse(generation); }, { Date: ClockDate });
    const rec = await consume(h);
    check('HTTP wait included in response/byte/total monotonic timings', rec.responseHeadersMs >= 50 && rec.firstByteMs >= 50 && rec.totalMs >= rec.firstByteMs && rec.endedAt < rec.startedAt && rec.timingSource === 'performance.now');
    check('first reasoning and answer delta observed with current patch format', rec.firstReasoningMs != null && rec.firstTextMs != null && rec.firstDeltaMs <= rec.firstTextMs);
    check('completed stream has both explicit completion signals', rec.streamComplete && rec.completionSignals.includes('[DONE]') && rec.completionSignals.includes('message_stream_complete') && !rec.transportCanceled);
    const diag = await h.diag();
    check('diagnostics transport/nested-resolved and UI request correlation', diag.requestId === 'synthetic_diag' && diag.diag.version === 3 && diag.diag.last.hasResolved && diag.diag.last.transport === 'sse');
    check('posted URL/href strip query/hash', h.messages.every(message => !JSON.stringify(message).includes('private=synthetic')));
  }
  {
    const h = harness(async url => { if (String(url).includes('/prepare')) return new Response('{}', { headers: { 'content-type': 'application/json' } }); await wait(50); return sse(generation); });
    const main = h.context.fetch('/backend-api/f/conversation', { method: 'POST', body: '{"model":"gpt-6"}' });
    await wait(5); await h.context.fetch('/backend-api/f/conversation/prepare', { method: 'POST', body: '{}' });
    await (await main).text(); await until(() => h.records().length);
    const rec = h.records()[0], diag = (await h.diag()).diag;
    check('concurrent prepare cannot alter generation endpoint/end', rec.endpoint === '/backend-api/f/conversation' && rec.endedAt != null && rec.totalMs >= 40);
    check('observed and generation diagnostic contexts remain independent', diag.lastObserved.endpoint.endsWith('/prepare') && diag.lastGeneration.endpoint === rec.endpoint && diag.lastGeneration.judgment === 'match' && diag.lastObserved.judgment === 'unmatched');
  }
  {
    class DelayedRequest {
      constructor() { this.url = 'https://chatgpt.com/backend-api/f/conversation'; this.method = 'POST'; }
      clone() { return { text: async () => { await wait(75); return '{"model":"gpt-6"}'; } }; }
    }
    const h = harness(async url => { if (String(url).includes('stop_conversation')) { await wait(160); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } return sse(generation); }, { Request: DelayedRequest });
    await (await h.context.fetch(new DelayedRequest())).text(); await wait(5);
    const stop = h.context.fetch('/backend-api/stop_conversation', { method: 'POST', body: '{}' });
    await until(() => h.records().length);
    check('delayed request metadata and concurrent stop cannot erase end time', h.records()[0].endedAt != null && h.records()[0].endpoint === '/backend-api/f/conversation' && h.records()[0].requestedModel === 'gpt-6');
    await stop;
  }
  {
    let received;
    const h = harness(async input => { received = await input.text(); return sse(generation); });
    const request = new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: '{"model":"gpt-6","messages":[{"content":"synthetic private text"}]}' });
    const rec = await consume(h, request, undefined);
    check('Request clone reads model without consuming original page body', received.includes('synthetic private text') && rec.requestedModel === 'gpt-6' && !JSON.stringify(rec).includes('synthetic private text'));
    const h2 = harness(async () => sse(generation));
    const override = await consume(h2, new Request('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: '{"model":"old"}' }), { body: '{"model":"gpt-6"}' });
    check('init.body override determines effective requested model', override.requestedModel === 'gpt-6');
    const h3 = harness(async () => sse(generation));
    const large = await consume(h3, '/backend-api/f/conversation', { method: 'POST', body: '{"model":"gpt-6","padding":"' + 'x'.repeat(2 * 1024 * 1024) + '"}' });
    check('oversized request metadata stays unknown without losing response route', large.requestedModel === null && large.serverModel === 'gpt-6');
    const h4 = harness(async () => sse(generation));
    const streamed = await consume(h4, '/backend-api/f/conversation', { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('synthetic')); controller.close(); } }) });
    check('unsupported init stream remains untouched and Requested unknown', streamed.requestedModel === null && streamed.serverModel === 'gpt-6');
  }
  {
    const error = new Error('synthetic original failure');
    const h = harness(() => Promise.reject(error));
    let caught; try { await h.context.fetch('/backend-api/f/conversation', { method: 'POST' }); } catch (value) { caught = value; }
    check('original fetch rejection identity preserved', caught === error && h.records().length === 0);
    const hs = harness(() => { throw error; });
    try { hs.context.fetch('/backend-api/f/conversation', { method: 'POST' }); } catch (value) { caught = value; }
    check('original synchronous fetch exception identity preserved', caught === error);
    const response = sse(generation), h2 = harness(() => Promise.resolve(response));
    check('fetch returns the exact original response object', await h2.context.fetch('/backend-api/f/conversation', { method: 'POST' }) === response);
    await response.text(); await until(() => h2.records().length);
    const response2 = sse(generation); response2.clone = () => { throw error; };
    const h3 = harness(() => Promise.resolve(response2));
    const original = await h3.context.fetch('/backend-api/f/conversation', { method: 'POST' });
    check('clone failure isolated and page body still readable', original === response2 && (await original.text()).includes('server_ste_metadata') && h3.records().length === 0);
    let cloned = false;
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } }); json.clone = () => { cloned = true; throw error; };
    const h4 = harness(() => Promise.resolve(json));
    await (await h4.context.fetch('/backend-api/f/conversation/prepare', { method: 'POST' })).text();
    check('known JSON helpers skipped before clone/body work', !cloned && !h4.records().length);
    const controller = new AbortController(); let signal;
    const h5 = harness((_, init) => { signal = init.signal; return Promise.resolve(sse(generation)); });
    await consume(h5, '/backend-api/f/conversation', { method: 'POST', body: '{"model":"gpt-6"}', signal: controller.signal });
    check('page AbortSignal object forwarded unchanged', signal === controller.signal && !controller.signal.aborted);
  }
  {
    for (const completed of [false, true]) {
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(toSSE(completed ? generation : generation.slice(0, 2)).replace(completed ? '$never' : 'data: [DONE]\n\n', ''))); setTimeout(() => { const error = new Error('synthetic aborted'); error.name = 'AbortError'; controller.error(error); }, 25); } });
      const h = harness(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
      const rec = await consume(h);
      check('completion independent of canceled transport: ' + completed, rec.streamComplete === completed && rec.transportCanceled && rec.aborted && rec.cancelReason === 'unknown');
    }
    const broken = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"resolved_model_slug":"gpt-6"}\n\n')); setTimeout(() => controller.error(new Error('synthetic socket failure')), 25); } });
    const h = harness(() => Promise.resolve(new Response(broken, { headers: { 'content-type': 'text/event-stream' } })));
    const rec = await consume(h);
    check('generic transport errors do not claim cancellation or completion', !rec.transportCanceled && !rec.aborted && !rec.streamComplete);
    const capped = 'data: {"resolved_model_slug":"gpt-6"}\n\ndata: {"padding":"' + 'x'.repeat(1024 * 1024 + 2) + '"}\n\ndata: [DONE]\n\n';
    const hc = harness(() => Promise.resolve(new Response(capped, { headers: { 'content-type': 'text/event-stream' } })));
    const cappedRec = await consume(hc);
    check('observer event cap returns bounded partial evidence without cancellation claim', cappedRec.captureLimited === 'event_limit' && !cappedRec.transportCanceled && !cappedRec.streamComplete && cappedRec.endedAt != null);
    const ht = harness(() => Promise.resolve(new Response('data: {"resolved_model_slug":"gpt-6"}\n\ndata: {"type":"message_stream_complete"}', { headers: { 'content-type': 'text/event-stream' } })));
    const tail = await consume(ht);
    check('unterminated tail completion does not assert full response', !tail.streamComplete && !tail.completionSignals.length);
  }
  {
    let controller, idleOffset = 0;
    const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new TextEncoder().encode('data: {"resolved_model_slug":"gpt-6"}\n\n')); } });
    const h = harness(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })), {
      performance: { now: () => performance.now() + idleOffset },
      setTimeout: (fn, ms) => setTimeout(() => { if (ms === 120000) idleOffset += 120000; fn(); }, ms === 120000 ? 20 : ms)
    });
    const response = await h.context.fetch('/backend-api/f/conversation', { method: 'POST', body: '{"model":"gpt-6"}' });
    const page = response.text();
    await until(() => h.records().length);
    const rec = h.records()[0];
    controller.enqueue(new TextEncoder().encode('synthetic page remains readable')); controller.close();
    check('idle timeout truncates observer without canceling the page stream', rec.captureLimited === 'idle_timeout' && !rec.transportCanceled && !rec.streamComplete && (await page).includes('page remains readable'));
    class SlowRequest {
      constructor() { this.url = 'https://chatgpt.com/backend-api/f/conversation'; this.method = 'POST'; }
      clone() { return { text: async () => { await wait(100); return '{"model":"gpt-6"}'; } }; }
    }
    const h2 = harness(() => Promise.resolve(sse(generation)), { Request: SlowRequest, setTimeout: (fn, ms) => setTimeout(fn, ms === 1500 ? 15 : ms) });
    const requestLimited = await consume(h2, new SlowRequest(), undefined);
    check('request metadata timeout preserves unknown Requested and response evidence', requestLimited.requestedModel === null && requestLimited.serverModel === 'gpt-6' && requestLimited.streamComplete && !requestLimited.captureLimited);
  }
  {
    const bytes = new TextEncoder().encode(toSSE(Array.from({ length: 20 }, () => generation).flat())), active = new Set();
    let timerCreates = 0, chunks = 0;
    const body = new ReadableStream({ start(controller) {
      let offset = 0;
      function push() {
        if (offset === bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(offset, ++offset)); chunks++; setImmediate(push);
      }
      push();
    } });
    const h = harness(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })), {
      setTimeout: (fn, ms) => { timerCreates++; const timer = setTimeout(() => { active.delete(timer); fn(); }, ms); active.add(timer); return timer; },
      clearTimeout: timer => { active.delete(timer); clearTimeout(timer); }
    });
    const rec = await consume(h);
    console.log('CONTROLLED small chunks: chunks=' + chunks + ', observer timers=' + timerCreates + ', active after completion=' + active.size);
    check('small SSE chunks share one idle watchdog and release all timers', chunks > 500 && rec.streamComplete && timerCreates === 1 && active.size === 0);
  }
  console.log('\nCore regressions: ' + passed + ' passed. Synthetic observer/filtered structure proof; not live browser acceptance.');
})().catch(error => { console.error(error); process.exitCode = 1; });

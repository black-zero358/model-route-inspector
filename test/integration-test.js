/*
 * test/integration-test.js
 * 在 Node 中模拟浏览器 MAIN world，验证 injected.js：
 *  - 包装 window.fetch，支持 /backend-api/f/conversation
 *  - 两阶段识别：只有带 generation 特征的流才产生记录
 *  - response.clone() 读副本，原始响应不受影响
 *  - 非 conversation URL / 非 generation 流不产生记录
 *  - 流错误不抛异常
 *  - 诊断计数可查询
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let passed = 0, failed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function makeSandbox() {
  const messages = [];
  const listeners = { message: [] };

  const sandbox = {
    console: console,
    Math: Math, Date: Date, JSON: JSON, Promise: Promise, Error: Error,
    String: String, Array: Array, Object: Object, Number: Number, Boolean: Boolean,
    TextDecoder: TextDecoder, Request: Request, Response: Response, ReadableStream: ReadableStream,
    setTimeout: setTimeout, setImmediate: setImmediate, clearTimeout: clearTimeout,
    URL: URL,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    addEventListener: function (type, fn) {
      if (listeners[type]) listeners[type].push(fn);
    },
    removeEventListener: function (type, fn) {
      if (listeners[type]) {
        const i = listeners[type].indexOf(fn);
        if (i !== -1) listeners[type].splice(i, 1);
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // vm 内的 window 是 contextified global proxy，事件 source 必须用它，=== 才成立
  const ctxGlobal = vm.runInContext('globalThis', sandbox);
  sandbox.postMessage = function (msg) {
    messages.push(msg);
    setImmediate(function () {
      listeners.message.slice().forEach(function (fn) {
        try { fn({ source: ctxGlobal, data: msg }); } catch (_) {}
      });
    });
  };
  return { sandbox: sandbox, messages: messages };
}

function loadInto(sandbox, relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  vm.runInContext(src, sandbox, { filename: relPath });
}

function loadAll(sandbox) {
  loadInto(sandbox, 'src/parser.js');
  loadInto(sandbox, 'src/detector.js');
  loadInto(sandbox, 'src/injected.js');
}

function sseResponse(events, chunkSize, contentType) {
  const encoder = new TextEncoder();
  let full = '';
  events.forEach(function (e) {
    if (e.event) full += 'event: ' + e.event + '\n';
    full += 'data: ' + e.data + '\n\n';
  });
  const bytes = encoder.encode(full);
  const body = new ReadableStream({
    start: function (controller) {
      let offset = 0;
      (function push() {
        if (offset >= bytes.length) { controller.close(); return; }
        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
        setImmediate(push);
      })();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType || 'text/event-stream' }
  });
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function recordsOf(messages) {
  return messages.filter(function (m) { return m.type === 'record'; }).map(function (m) { return m.record; });
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function run() {
  console.log('\n== injected.js integration ==');

  // ---- 场景 1：/backend-api/f/conversation 正常捕获 + 极小 chunk + 原流完整 ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    const events = [
      { data: JSON.stringify({ type: 'response_created', model_slug: 'gpt-5-6-thinking', resolved_model_slug: 'gpt-5-6-thinking', conversation_id: 'conv-A', message_id: 'msg-A' }) },
      { data: JSON.stringify({ type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-6-thinking', cluster_region: 'japaneast', server_ttfvt_ms: 1644.749, fast_convo: true, plan_type: 'plus' } }) },
      { data: '[DONE]' }
    ];
    const origResponse = sseResponse(events, 3);
    let pageText = '';
    sandbox.fetch = function () { return Promise.resolve(origResponse); };
    loadAll(sandbox);

    return sandbox.window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-5-6-thinking' })
    }).then(function (res) { return res.text(); }).then(function (t) {
      pageText = t;
      return wait(300);
    }).then(function () {
      assert(pageText.indexOf('server_ste_metadata') !== -1, '[f] original body fully readable by page');
      const recs = recordsOf(messages);
      assert(recs.length === 1, '[f] one record produced (got ' + recs.length + ')');
      const r = recs[0];
      assert(r.status === 'match', '[f] status=match (' + r.status + ')');
      assert(r.endpoint === '/backend-api/f/conversation', '[f] endpoint captured');
      assert(r.requestedModel === 'gpt-5-6-thinking', '[f] requestedModel');
      assert(r.serverModel === 'gpt-5-6-thinking', '[f] serverModel');
      assert(r.clusterRegion === 'japaneast', '[f] clusterRegion');
      assert(r.fastConvo === true, '[f] fastConvo');
      assert(r.planType === 'plus', '[f] planType');
      assert(r.transport === 'sse', '[f] transport=sse');
    });
  })();

  // ---- 场景 2：/f/conversation mismatch 5.6 -> 5.5-mini ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    const events = [
      { data: JSON.stringify({ type: 'response_created', resolved_model_slug: 'gpt-5-5-mini' }) },
      { data: JSON.stringify({ type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-5-mini' } }) },
      { data: '[DONE]' }
    ];
    sandbox.fetch = function () { return Promise.resolve(sseResponse(events, 50)); };
    loadAll(sandbox);
    return sandbox.window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-5-6-thinking' })
    }).then(function (r) { return r.text(); }).then(function () { return wait(200); }).then(function () {
      const recs = recordsOf(messages);
      assert(recs.length === 1, '[f-mismatch] one record');
      assert(recs[0].status === 'mismatch', '[f-mismatch] 5.6 -> 5.5-mini = mismatch (' + recs[0].status + ')');
    });
  })();

  // ---- 场景 3：两阶段识别——conversation URL 但返回普通 JSON（无 generation 特征）→ 不产生记录 ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    sandbox.fetch = function () { return Promise.resolve(jsonResponse({ title: 'some title', status: 'ok' })); };
    loadAll(sandbox);
    return sandbox.window.fetch('https://chatgpt.com/backend-api/conversation/title', {
      method: 'POST', body: JSON.stringify({})
    }).then(function (r) { return r.json(); }).then(function (j) {
      return wait(200).then(function () {
        assert(j.status === 'ok', '[2stage] page receives JSON normally');
        assert(recordsOf(messages).length === 0, '[2stage] no record for non-generation stream');
      });
    });
  })();

  // ---- 场景 4：旧 URL /backend-api/conversation 仍然支持 ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    const events = [
      { data: JSON.stringify({ type: 'response_created', resolved_model_slug: 'gpt-5' }) },
      { data: JSON.stringify({ type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5' } }) },
      { data: '[DONE]' }
    ];
    sandbox.fetch = function () { return Promise.resolve(sseResponse(events, 40)); };
    loadAll(sandbox);
    return sandbox.window.fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-5' })
    }).then(function (r) { return r.text(); }).then(function () { return wait(200); }).then(function () {
      assert(recordsOf(messages).length === 1, '[legacy] /backend-api/conversation still works');
    });
  })();

  // ---- 场景 5：非 conversation URL 放行 ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    sandbox.fetch = function () { return Promise.resolve(new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } })); };
    loadAll(sandbox);
    return sandbox.window.fetch('https://chatgpt.com/backend-api/me').then(function (r) { return r.json(); }).then(function (j) {
      return wait(100).then(function () {
        assert(j.ok === 1, '[passthrough] non-conversation fetch passes through');
        assert(recordsOf(messages).length === 0, '[passthrough] no record');
      });
    });
  })();

  // ---- 场景 6：流错误不抛异常 ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start: function (c) {
        c.enqueue(encoder.encode('data: {"type":"response_created","resolved_model_slug":"gpt-5"'));
        setTimeout(function () { c.error(new Error('aborted')); }, 20);
      }
    });
    sandbox.fetch = function () {
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    };
    loadAll(sandbox);
    return sandbox.window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-5' })
    }).then(function (r) {
      return r.text().catch(function () { return ''; });
    }).then(function () { return wait(200); }).then(function () {
      const recs = recordsOf(messages);
      assert(recs.length <= 1, '[abort] no crash on stream error');
      // 流在命中 generation marker 之前就断了 → 不应产生记录
      assert(recs.length === 0, '[abort] no record when stream errors before marker');
    });
  })();

  // ---- 场景 7：诊断计数 ----
  await (function () {
    const { sandbox, messages } = makeSandbox();
    const events = [
      { data: JSON.stringify({ type: 'response_created', resolved_model_slug: 'gpt-5-6-thinking' }) },
      { data: JSON.stringify({ type: 'server_ste_metadata', metadata: { model_slug: 'gpt-5-6-thinking' } }) },
      { data: '[DONE]' }
    ];
    sandbox.fetch = function () { return Promise.resolve(sseResponse(events, 60)); };
    loadAll(sandbox);

    return sandbox.window.fetch('https://chatgpt.com/backend-api/f/conversation', {
      method: 'POST', body: JSON.stringify({ model: 'gpt-5-6-thinking' })
    }).then(function (r) { return r.text(); }).then(function () { return wait(300); }).then(function () {
      // 请求诊断
      sandbox.window.postMessage({ source: 'mri', type: 'diag-request' }, '*');
      return wait(100);
    }).then(function () {
      const diagMsg = messages.find(function (m) { return m.type === 'diag'; });
      assert(!!diagMsg, '[diag] diag response received');
      if (!diagMsg) return;
      const d = diagMsg.diag;
      assert(d.hookInstalled === true, '[diag] hookInstalled');
      assert(d.fetchCalls >= 1, '[diag] fetchCalls >= 1 (' + d.fetchCalls + ')');
      assert(d.candidates === 1, '[diag] candidates=1 (' + d.candidates + ')');
      assert(d.matched === 1, '[diag] matched=1 (' + d.matched + ')');
      assert(d.records === 1, '[diag] records=1 (' + d.records + ')');
      assert(d.last.endpoint === '/backend-api/f/conversation', '[diag] last.endpoint');
      assert(d.last.method === 'POST', '[diag] last.method=POST');
      assert(d.last.status === 200, '[diag] last.status=200');
      assert(d.last.contentType.indexOf('event-stream') !== -1, '[diag] last.contentType is SSE');
      assert(d.last.chunks > 0, '[diag] chunks>0 (' + d.last.chunks + ')');
      assert(d.last.events > 0, '[diag] events>0 (' + d.last.events + ')');
      assert(d.last.hasServerSte === true, '[diag] hasServerSte');
      assert(d.last.hasResolved === true, '[diag] hasResolved');
      assert(d.last.judgment === 'match', '[diag] judgment=match (' + d.last.judgment + ')');
      assert(d.last.parserError === null, '[diag] no parser error');
    });
  })();

  console.log('\n----------------------------------------');
  console.log('INTEGRATION PASSED: ' + passed + '   FAILED: ' + failed);
  console.log('----------------------------------------\n');
  process.exit(failed ? 1 : 0);
}

run().catch(function (e) { console.error('Integration test crashed:', e); process.exit(1); });

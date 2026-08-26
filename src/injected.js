/*
 * injected.js — 运行在页面 MAIN world，包装 window.fetch
 *
 * 两阶段识别：
 *   1) 粗筛：同域 + POST + 路径含 conversation + response.body 存在 → clone 流
 *   2) 确认：流中出现 generation 特征（server_ste_metadata / message_marker /
 *      message_stream_complete / conversation_detail_metadata / delta_encoding /
 *      resume_conversation_token）才认定为 ChatGPT generation stream
 *
 * 任何异常都被隔离，不影响页面自身的 fetch / stream / AbortController。
 * 不记录请求/响应正文与认证凭据，只提取路由元数据。
 *
 * 自带诊断计数，通过 window.postMessage({source:'mri', type:'diag-request'}) 查询。
 */
(function () {
  'use strict';

  if (window.__MRI_INJECTED__) return;
  window.__MRI_INJECTED__ = true;

  const MRI = window.__MRI__ || {};
  const createParser = MRI.createParser;
  const createRecord = MRI.createRecord;
  const extractFields = MRI.extractFields;
  const isGenerationEvent = MRI.isGenerationEvent;
  const finalizeTiming = MRI.finalizeTiming;
  const judge = MRI.judge;

  if (!createParser || !createRecord || !extractFields || !judge) return;

  // ---- 诊断状态（累计自页面加载起）----
  const diag = {
    version: 2,
    href: location.href,
    injectedAt: Date.now(),
    hookInstalled: true,
    fetchCalls: 0,
    candidates: 0,
    matched: 0,
    records: 0,
    unknownMetaKeys: [],
    last: emptyLast()
  };

  function emptyLast() {
    return {
      url: null, endpoint: null, method: null,
      status: null, contentType: null, transport: null,
      chunks: 0, events: 0, jsonEvents: 0,
      hasServerSte: false, hasResolved: false, hasRequested: false,
      matched: false,
      parserError: null, error: null,
      startedAt: null, endedAt: null,
      judgment: null, requestedModel: null, resolvedModel: null, serverModel: null
    };
  }

  function addUnknownMetaKey(k) {
    if (diag.unknownMetaKeys.indexOf(k) === -1) diag.unknownMetaKeys.push(k);
  }

  function snapshotDiag() {
    return {
      version: diag.version,
      href: diag.href,
      now: Date.now(),
      injectedAt: diag.injectedAt,
      hookInstalled: diag.hookInstalled,
      fetchCalls: diag.fetchCalls,
      candidates: diag.candidates,
      matched: diag.matched,
      records: diag.records,
      unknownMetaKeys: diag.unknownMetaKeys.slice(),
      last: Object.assign({}, diag.last)
    };
  }

  const POST = function (msg) {
    try { window.postMessage(Object.assign({ source: 'mri', href: location.href }, msg), '*'); }
    catch (_) { /* ignore */ }
  };

  // 第一阶段：粗筛（不硬编码具体版本路径，未来 /backend-api/v2/conversation 也能命中）
  function isConversationCandidate(url, method) {
    if (!url) return false;
    if (String(method).toUpperCase() !== 'POST') return false;
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin) return false;
      return u.pathname.toLowerCase().indexOf('conversation') !== -1;
    } catch (_) {
      return false;
    }
  }

  function endpointOf(url) {
    try { return new URL(url, location.origin).pathname; } catch (_) { return url; }
  }

  function parseModelFromBody(text) {
    if (!text) return null;
    try {
      const b = JSON.parse(text);
      if (b && typeof b.model === 'string') return b.model;
    } catch (_) { /* ignore */ }
    return null;
  }

  function readRequestedModel(input, init) {
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        return input.clone().text().then(parseModelFromBody).catch(function () { return null; });
      }
      if (init && typeof init.body === 'string') {
        return Promise.resolve(parseModelFromBody(init.body));
      }
      if (init && init.body && typeof init.body === 'object' && typeof Request !== 'undefined') {
        try {
          return new Request(input, init).text().then(parseModelFromBody).catch(function () { return null; });
        } catch (_) { return Promise.resolve(null); }
      }
    } catch (_) { /* ignore */ }
    return Promise.resolve(null);
  }

  const origFetch = window.fetch;
  if (typeof origFetch !== 'function') {
    diag.hookInstalled = false;
    return;
  }

  window.fetch = function (input, init) {
    diag.fetchCalls++;

    let url = '', method = 'GET';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
      method = (init && init.method) || (input && input.method) || 'GET';
    } catch (_) { /* ignore */ }

    if (!isConversationCandidate(url, method)) {
      return origFetch.apply(this, arguments);
    }

    const requestId = 'mri_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const requestedModelPromise = readRequestedModel(input, init);

    // 初始化本次诊断快照
    diag.candidates++;
    diag.last = emptyLast();
    diag.last.url = url;
    diag.last.endpoint = endpointOf(url);
    diag.last.method = String(method).toUpperCase();
    diag.last.startedAt = Date.now();

    POST({ type: 'request-start', requestId: requestId, url: url, at: Date.now() });

    return origFetch.apply(this, arguments).then(function (response) {
      try {
        diag.last.status = response.status;
        const ct = (response.headers && response.headers.get('content-type')) || '';
        diag.last.contentType = ct || null;

        if (!response.body) {
          diag.last.error = 'no response.body';
          return response;
        }

        const cloned = response.clone();
        const rec = createRecord(requestId, url);
        rec.endpoint = diag.last.endpoint;
        rec.transport = 'sse';
        rec.responseStatus = response.status;
        rec.contentType = ct || null;

        let matched = false;
        let firstByteAt = null;
        let firstDeltaAt = null;
        let preMatchChars = 0;
        const PRE_MATCH_CAP = 512 * 1024; // 命中前的安全上限，防止把大 JSON 整个缓冲

        const diagCollector = { addUnknownMetaKey: addUnknownMetaKey };

        const parser = createParser(function (ev) {
          try {
            diag.last.events++;
            if (ev.done) return;
            if (ev.parseError) {
              diag.last.parserError = (ev.error || 'parse error').slice(0, 200);
              return;
            }
            if (ev.data && typeof ev.data === 'object') {
              diag.last.jsonEvents++;
              if (!matched && isGenerationEvent(ev.data)) {
                matched = true;
                diag.matched++;
                diag.last.matched = true;
              }
              if (matched) {
                extractFields(ev.data, rec, diagCollector);
                if (!diag.last.hasServerSte &&
                    ev.data && ev.data.type === 'server_ste_metadata') {
                  diag.last.hasServerSte = true;
                }
                if (!diag.last.hasResolved && ev.data && ev.data.resolved_model_slug) {
                  diag.last.hasResolved = true;
                }
                // 首个 delta 事件时间
                if (firstDeltaAt === null && ev.data &&
                    (ev.data.type === 'delta' || ev.data.delta || ev.data.message?.status === 'in_progress')) {
                  firstDeltaAt = Date.now();
                }
              }
            }
          } catch (e) {
            diag.last.parserError = String(e && e.message || e).slice(0, 200);
          }
        });

        (async function () {
          let reader;
          try {
            reader = cloned.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              diag.last.chunks++;
              if (firstByteAt === null) firstByteAt = Date.now();
              const text = decoder.decode(chunk.value, { stream: true });
              preMatchChars += text.length;
              parser.feed(text);
              // 命中前安全上限：非 generation 流（例如大 JSON）不继续读
              if (!matched && preMatchChars > PRE_MATCH_CAP) {
                diag.last.error = 'pre-match cap exceeded; not a generation stream';
                try { await reader.cancel(); } catch (_) {}
                return;
              }
            }
            parser.feed(decoder.decode());
            parser.end();
          } catch (e) {
            diag.last.error = 'stream read error: ' + String(e && e.message || e).slice(0, 200);
            rec.aborted = true;
          } finally {
            diag.last.endedAt = Date.now();
            if (firstByteAt && rec.startedAt) rec.firstByteMs = firstByteAt - rec.startedAt;
            if (firstDeltaAt && rec.startedAt) rec.firstDeltaMs = firstDeltaAt - rec.startedAt;

            if (matched) {
              try { rec.requestedModel = await requestedModelPromise; } catch (_) {}
              rec.endedAt = diag.last.endedAt;
              finalizeTiming(rec);
              judge(rec);

              diag.records++;
              diag.last.hasRequested = !!rec.requestedModel;
              diag.last.judgment = rec.status;
              diag.last.requestedModel = rec.requestedModel;
              diag.last.resolvedModel = rec.resolvedModel;
              diag.last.serverModel = rec.serverModel;

              POST({ type: 'record', record: rec });
            } else {
              diag.last.judgment = 'unmatched';
              // 不产生记录，但诊断里能看到这次候选为什么没命中
            }
          }
        })();

        return response;
      } catch (e) {
        diag.last.error = 'hook error: ' + String(e && e.message || e).slice(0, 200);
        return response;
      }
    });
  };

  // 响应诊断查询
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'mri' || msg.type !== 'diag-request') return;
    POST({ type: 'diag', diag: snapshotDiag() });
  });

  POST({ type: 'injected', at: Date.now() });
})();

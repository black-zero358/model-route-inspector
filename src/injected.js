/*
 * MAIN-world observer: request-local diagnostics and monotonic browser timings.
 * Reads response clones only; never stores body text, credentials or URL query strings.
 */
(function () {
  'use strict';
  if (window.__MRI_INJECTED__) return;
  const MRI = window.__MRI__ || {};
  if (!MRI.createParser || !MRI.createRecord || !MRI.extractFields || !MRI.judge) return;
  const origFetch = window.fetch;
  if (typeof origFetch !== 'function') return;
  window.__MRI_INJECTED__ = true;

  const hasPerformance = typeof performance !== 'undefined' && typeof performance.now === 'function';
  const now = hasPerformance ? function () { return performance.now(); } : function () { return Date.now(); };
  const elapsed = function (start) { return Math.round(Math.max(0, now() - start)); };
  function safeURL(url) {
    try { const u = new URL(url, location.origin); return u.origin + u.pathname; }
    catch (_) { return null; }
  }
  function endpointOf(url) { try { return new URL(url, location.origin).pathname; } catch (_) { return null; } }
  function emptyLast() {
    return { requestId: null, url: null, endpoint: null, method: null, status: null,
      contentType: null, transport: null, chunks: 0, events: 0, jsonEvents: 0,
      hasServerSte: false, hasResolved: false, hasRequested: false, matched: false,
      parserError: null, error: null, startedAt: null, endedAt: null,
      judgment: null, requestedModel: null, resolvedModel: null, serverModel: null,
      streamComplete: false, transportCanceled: false, captureLimited: false };
  }
  const diag = { version: 3, href: safeURL(location.href), injectedAt: Date.now(),
    hookInstalled: true, fetchCalls: 0, candidates: 0, matched: 0, records: 0,
    unknownMetaKeys: [], unknownMetaTypes: {}, lastObserved: null, lastGeneration: null };
  let sequence = 0, generationSequence = 0;
  const unknownKeys = new Set();
  function unknown(k, type) {
    if (!unknownKeys.has(k) && unknownKeys.size < 128) {
      unknownKeys.add(k); diag.unknownMetaKeys.push(k); diag.unknownMetaTypes[k] = type;
    }
  }
  function snapshotDiag() {
    return Object.assign({}, diag, { now: Date.now(),
      unknownMetaKeys: diag.unknownMetaKeys.slice(), unknownMetaTypes: Object.assign({}, diag.unknownMetaTypes),
      last: Object.assign({}, diag.lastGeneration || diag.lastObserved || emptyLast()),
      lastObserved: diag.lastObserved ? Object.assign({}, diag.lastObserved) : null,
      lastGeneration: diag.lastGeneration ? Object.assign({}, diag.lastGeneration) : null });
  }
  function post(msg) {
    try { window.postMessage(Object.assign({ source: 'mri', href: safeURL(location.href) }, msg), '*'); }
    catch (_) { /* observer never affects the page */ }
  }
  function candidate(url, method) {
    if (String(method).toUpperCase() !== 'POST') return false;
    try { const u = new URL(url, location.origin); return u.origin === location.origin && /conversation/i.test(u.pathname); }
    catch (_) { return false; }
  }
  function cancelReader(reader) {
    // Response.clone uses tee; cancellation may await the page's other branch.
    // Never await it or cancel the original response.
    try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (_) {}
  }
  function parseModel(text) {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return null;
    try {
      const body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      const safeId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
      const effortKey = Object.prototype.hasOwnProperty.call(body, 'thinking_effort') ? 'thinking_effort' : 'reasoning_effort';
      return { model: typeof body.model === 'string' && body.model.length <= 256 ? body.model : null,
        effort: typeof body[effortKey] === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(body[effortKey]) ? body[effortKey] : null,
        effortKey: effortKey, conversationId: safeId(body.conversation_id) ? body.conversation_id : null,
        requestAction: ['next', 'variant', 'continue'].includes(body.action) ? body.action : null,
        requestedParentMessageId: safeId(body.parent_message_id) ? body.parent_message_id : null,
        inputMessageIds: Array.isArray(body.messages) && body.messages.length <= 32 ? Array.from(new Set(body.messages.filter(m => m && m.author && m.author.role === 'user' && safeId(m.id)).map(m => m.id))) : [] };
    }
    catch (_) { return null; }
  }
  function timeoutPromise(ms, onTimeout) {
    let timer;
    const promise = new Promise(function (resolve) { timer = setTimeout(function () { onTimeout(); resolve(null); }, ms); });
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { promise: promise, clear: function () { clearTimeout(timer); } };
  }
  function readRequestedModel(input, init) {
    try {
      // Explicit init.body overrides a Request body; do not report the overridden model.
      if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
        return Promise.resolve(typeof init.body === 'string' ? parseModel(init.body) : null);
      }
      if (typeof Request === 'undefined' || !(input instanceof Request)) return Promise.resolve(null);
      const copy = input.clone();
      if (!copy.body || typeof copy.body.getReader !== 'function') {
        const timeout = timeoutPromise(1500, function () {});
        return Promise.race([copy.text().then(parseModel).catch(function () { return null; }), timeout.promise])
          .finally(timeout.clear);
      }
      const reader = copy.body.getReader();
      const timeout = timeoutPromise(1500, function () { cancelReader(reader); });
      const work = (async function () {
        const decoder = new TextDecoder(), parts = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 2 * 1024 * 1024) { cancelReader(reader); return null; }
            parts.push(decoder.decode(chunk.value, { stream: true }));
          }
          parts.push(decoder.decode());
          return parseModel(parts.join(''));
        } catch (_) { return null; }
        finally { parts.length = 0; try { reader.releaseLock(); } catch (_) {} }
      })();
      return Promise.race([work, timeout.promise]).finally(timeout.clear);
    } catch (_) { return Promise.resolve(null); }
  }

  async function observe(response, rec, ctx, start, requestedPromise, order) {
    let reader, parser, idleTimer;
    let matched = false, preMatchBytes = 0, limited = false;
    const eventState = {};
    const pendingMarkers = new Map();
    function resolveMarkers() {
      pendingMarkers.forEach(function (marker, id) {
        if (!MRI.isAssociatedAssistant || !MRI.isAssociatedAssistant(eventState, id, rec)) return;
        if (rec.firstTokenMs == null || marker.ms < rec.firstTokenMs) { rec.firstTokenMs = marker.ms; rec.firstTokenSource = marker.source; }
      });
    }
    function complete(signal) {
      if (rec.completionSignals.indexOf(signal) < 0) rec.completionSignals.push(signal);
      rec.streamComplete = true; ctx.streamComplete = true;
      if (rec.completionMs == null) rec.completionMs = elapsed(start);
    }
    function match() {
      if (matched) return;
      matched = true; ctx.matched = true; diag.matched++;
      if (order >= generationSequence) { generationSequence = order; diag.lastGeneration = ctx; }
    }
    try {
      reader = response.clone().body.getReader();
      let lastActivity = now();
      function watchIdle() {
        const idle = Math.max(0, now() - lastActivity);
        if (idle >= 120000) {
          limited = true; rec.captureLimited = 'idle_timeout'; ctx.captureLimited = rec.captureLimited;
          cancelReader(reader);
          return;
        }
        idleTimer = setTimeout(watchIdle, Math.max(1, 120000 - idle));
        if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
      }
      idleTimer = setTimeout(watchIdle, 120000);
      if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
      const decoder = new TextDecoder();
      parser = MRI.createParser(function (event) {
        if (limited) return;
        ctx.events++;
        if (event.parseError) {
          ctx.parserError = event.limitExceeded ? 'SSE event exceeds capture limit' : 'Invalid SSE JSON';
          if (event.limitExceeded) { limited = true; rec.captureLimited = 'event_limit'; ctx.captureLimited = rec.captureLimited; }
          return;
        }
        if (event.done) { if (matched && !event.unterminated) complete('[DONE]'); return; }
        if (!event.data || typeof event.data !== 'object') return;
        ctx.jsonEvents++;
        const summary = MRI.extractFields(event.data, rec, { addUnknownMetaKey: unknown }, eventState);
        if (summary.limited) { rec.captureLimited = 'structure_limit'; ctx.captureLimited = rec.captureLimited; }
        if (summary.generation) match();
        if (!matched) return;
        ctx.hasResolved = !!rec.resolvedModel; ctx.hasServerSte = !!rec.serverModel || ctx.hasServerSte;
        // An empty STE block is still an observed block.
        if (event.data.type === 'server_ste_metadata') ctx.hasServerSte = true;
        if (summary.complete && !event.unterminated) complete('message_stream_complete');
        if (summary.tokenMarker && pendingMarkers.size < 64 && !pendingMarkers.has(summary.tokenMarker.id)) pendingMarkers.set(summary.tokenMarker.id, { source: summary.tokenMarker.source, ms: elapsed(start) });
        resolveMarkers();
        if (summary.text && rec.firstTextMs == null) rec.firstTextMs = elapsed(start);
        if (summary.reasoning && rec.firstReasoningMs == null) rec.firstReasoningMs = elapsed(start);
        if ((summary.text || summary.reasoning) && rec.firstDeltaMs == null) rec.firstDeltaMs = elapsed(start);
      });
      while (!limited) {
        const chunk = await reader.read();
        if (chunk.done) break;
        lastActivity = now();
        ctx.chunks++;
        if (chunk.value.byteLength && rec.firstByteMs == null) rec.firstByteMs = elapsed(start);
        // A large network chunk must not become an equally large decoded string.
        for (let offset = 0; offset < chunk.value.byteLength && !limited; offset += 65536) {
          const bytes = chunk.value.subarray(offset, Math.min(offset + 65536, chunk.value.byteLength));
          if (!matched) preMatchBytes += bytes.byteLength;
          parser.feed(decoder.decode(bytes, { stream: true }));
          if (!matched && preMatchBytes > 512 * 1024) {
            limited = true; rec.captureLimited = 'pre_match_limit'; ctx.captureLimited = rec.captureLimited;
          }
        }
      }
      if (!limited) { parser.feed(decoder.decode()); parser.end(); }
      else cancelReader(reader);
    } catch (error) {
      const canceled = !!(error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message || '')));
      rec.transportCanceled = canceled; rec.aborted = canceled;
      rec.cancelReason = canceled ? 'unknown' : null;
      ctx.transportCanceled = canceled;
      ctx.error = canceled ? 'transport canceled; initiator unknown' : 'observer stream read failed';
    } finally {
      clearTimeout(idleTimer);
      if (parser && parser.dispose) parser.dispose();
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
      // End time belongs to the stream, never to a model-body read or another request.
      rec.endedAt = Date.now(); rec.totalMs = elapsed(start); ctx.endedAt = rec.endedAt;
      if (matched) {
        try {
          const requested = await requestedPromise;
          if (requested) {
            rec.requestedModel = requested.model;
            rec.requestedThinkingEffort = requested.effort;
            rec.inputMessageIds = requested.inputMessageIds;
            rec.requestAction = requested.requestAction;
            rec.requestedParentMessageId = requested.requestedParentMessageId;
            if (!rec.conversationId && requested.conversationId) {
              rec.conversationId = requested.conversationId;
              rec.fieldSources.conversationId = 'request.body.conversation_id'; rec.fieldStates.conversationId = 'value';
            }
            if (requested.effort) { rec.fieldSources.requestedThinkingEffort = 'request.body.' + requested.effortKey; rec.fieldStates.requestedThinkingEffort = 'value'; }
            if (requested.requestAction) { rec.fieldSources.requestAction = 'request.body.action'; rec.fieldStates.requestAction = 'value'; }
            if (requested.requestedParentMessageId) { rec.fieldSources.requestedParentMessageId = 'request.body.parent_message_id'; rec.fieldStates.requestedParentMessageId = 'value'; }
          }
        } catch (_) {}
        if (rec.requestedModel != null) {
          rec.fieldSources.requestedModel = 'request.body.model';
          rec.fieldStates.requestedModel = rec.requestedModel === '' ? 'empty' : 'value';
        }
        resolveMarkers(); if (MRI.finalizeCapture) MRI.finalizeCapture(rec, eventState); MRI.finalizeTiming(rec); MRI.judge(rec);
        ctx.hasRequested = !!rec.requestedModel; ctx.judgment = rec.status;
        ctx.requestedModel = rec.requestedModel; ctx.resolvedModel = rec.resolvedModel; ctx.serverModel = rec.serverModel;
        diag.records++; post({ type: 'record', record: rec });
      } else ctx.judgment = 'unmatched';
    }
  }

  window.fetch = function (input, init) {
    diag.fetchCalls++;
    let url = '', method = 'GET';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url || '';
      method = init && init.method || input && input.method || 'GET';
    } catch (_) {}
    if (!candidate(url, method)) return origFetch.apply(this, arguments);
    const start = now(), startedAt = Date.now(), order = ++sequence;
    const requestId = 'mri_' + startedAt.toString(36) + '_' + order.toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const ctx = emptyLast();
    Object.assign(ctx, { requestId: requestId, url: safeURL(url), endpoint: endpointOf(url),
      method: String(method).toUpperCase(), startedAt: startedAt });
    diag.candidates++; diag.lastObserved = ctx;
    const rec = MRI.createRecord(requestId, ctx.url);
    Object.assign(rec, { endpoint: ctx.endpoint, startedAt: startedAt,
      timingSource: hasPerformance ? 'performance.now' : 'date.now' });
    const requestedPromise = readRequestedModel(input, init);
    requestedPromise.then(function (requested) {
      if (requested) {
        rec.inputMessageIds = requested.inputMessageIds;
        rec.requestAction = requested.requestAction;
        rec.requestedParentMessageId = requested.requestedParentMessageId;
        post({ type: 'request-context', context: { requestId: requestId, inputMessageIds: requested.inputMessageIds, conversationId: requested.conversationId, requestAction: requested.requestAction, requestedParentMessageId: requested.requestedParentMessageId } });
      }
    }).catch(function () {});
    post({ type: 'request-start', requestId: requestId, url: ctx.url, at: startedAt });
    let fetchPromise;
    try { fetchPromise = origFetch.apply(this, arguments); }
    catch (error) { ctx.error = 'fetch failed'; ctx.endedAt = Date.now(); throw error; }
    return fetchPromise.then(function (response) {
      try {
        ctx.status = response.status;
        const ct = response.headers && response.headers.get('content-type') || '';
        ctx.contentType = ct || null;
        rec.responseStatus = response.status; rec.contentType = ct || null; rec.responseHeadersMs = elapsed(start);
        // Ordinary JSON helper requests are never cloned or read.
        if (!response.body || (ct && !/text\/event-stream/i.test(ct))) {
          ctx.error = response.body ? null : 'no response.body'; ctx.endedAt = Date.now(); ctx.judgment = 'unmatched';
          return response;
        }
        ctx.transport = 'sse'; rec.transport = 'sse';
        observe(response, rec, ctx, start, requestedPromise, order).catch(function () { ctx.error = 'observer failed'; });
      } catch (_) { ctx.error = 'observer setup failed'; ctx.endedAt = Date.now(); }
      return response;
    }, function (error) {
      ctx.error = error && error.name === 'AbortError' ? 'fetch canceled' : 'fetch failed';
      ctx.transportCanceled = !!(error && error.name === 'AbortError'); ctx.endedAt = Date.now();
      throw error; // Preserve the original rejection object.
    });
  };
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg && msg.source === 'mri' && msg.type === 'diag-request') {
      const requestId = typeof msg.requestId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(msg.requestId) ? msg.requestId : undefined;
      post({ type: 'diag', requestId: requestId, diag: snapshotDiag() });
    }
  });
  post({ type: 'injected', at: Date.now() });
})();

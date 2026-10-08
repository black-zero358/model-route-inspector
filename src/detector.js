/*
 * detector.js — 从已解析的 SSE JSON 事件中提取模型路由/调度/传输/性能字段，并做一致性判定
 *
 * 可在 Node（测试）与浏览器 MAIN world / service worker 中运行。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.__MRI__ = Object.assign(root.__MRI__ || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---- 常量 ----

  // 第二阶段识别：看到这些事件 type 或顶层 key，即认定为 ChatGPT generation stream
  const GENERATION_MARKERS = [
    'server_ste_metadata',
    'message_marker',
    'message_stream_complete',
    'conversation_detail_metadata',
    'delta_encoding',
    'resume_conversation_token',
    'resolved_model_slug',
    'default_model_slug'
  ];

  // 敏感字段：只用于“识别”，绝不保存其值（也不作为 unknown key 记录）
  const SENSITIVE_KEYS = new Set([
    'resume_conversation_token',
    'access_token',
    'refresh_token',
    'id_token',
    'session_token',
    'token',
    'authorization',
    'cookie',
    'set_cookie', 'user_agent', 'user-agent', 'api_key', 'password', 'secret', 'credentials'
  ]);

  // server_ste_metadata.metadata 中已知的字段（用于发现未知 key）
  const KNOWN_META_KEYS = new Set([
    'model_slug', 'cluster_region', 'region', 'server_ttfvt_ms',
    'fast_convo', 'warmup_state', 'conduit_prewarmed', 'is_first_turn',
    'resume_with_websockets',
    'plan_type', 'plan_type_bucket',
    'is_autoswitcher_enabled', 'auto_switcher_race_winner',
    'did_auto_switch_to_reasoning', 'model_switcher_deny',
    'product_experience', 'requested_model_experience', 'thinking_effort', 'turn_use_case', 'turn_mode',
    'tool_name', 'tool_invoked',
    'is_search', 'search_tool_call_count', 'search_tool_query_types',
    'is_multimodal', 'did_prompt_contain_image',
    'request_id', 'turn_exchange_id', 'turn_trace_id',
    'reasoning_start_time', 'reasoning_end_time', 'finished_duration_sec',
    'denoised_model_slug', 'archetype', 'model_provider',
    'delta_encoding', 'conversation_id', 'message_id'
  ]);

  function createRecord(requestId, url) {
    return {
      // identity
      requestId: requestId || null,
      url: url || null,
      endpoint: null,
      startedAt: Date.now(),
      endedAt: null,

      conversationId: null,
      messageId: null,
      serverRequestId: null,
      turnExchangeId: null,
      turnTraceId: null,

      // routing
      requestedModel: null,
      defaultModel: null,
      resolvedModel: null,
      serverModel: null,
      messageModel: null,
      modelSlug: null,

      requestedExperience: null,
      thinkingEffort: null,

      isAutoswitcherEnabled: null,
      didAutoSwitchToReasoning: null,
      autoSwitcherRaceWinner: null,
      modelSwitcherDeny: null,

      // product / account
      planType: null,
      planTypeBucket: null,
      productExperience: null,
      turnMode: null,
      turnUseCase: null,

      // serving
      fastConvo: null,
      warmupState: null,
      conduitPrewarmed: null,
      isFirstTurn: null,

      // infrastructure
      clusterRegion: null,
      region: null,
      serverTtfvt: null,

      // transport
      transport: null,
      responseStatus: null,
      contentType: null,
      resumeWithWebsockets: null,

      // task
      toolInvoked: null,
      toolName: null,
      isSearch: null,
      searchToolCallCount: null,
      searchToolQueryTypes: null,
      isMultimodal: null,
      didPromptContainImage: null,

      // timing
      responseHeadersMs: null,
      firstTextMs: null,
      firstReasoningMs: null,
      completionMs: null,
      timingSource: null,
      streamComplete: false,
      completionSignals: [],
      transportCanceled: false,
      cancelReason: null,
      aborted: false,
      captureLimited: false,
      firstByteMs: null,
      firstDeltaMs: null,
      totalMs: null,
      reasoningStartTime: null,
      reasoningEndTime: null,
      reasoningDurationMs: null,
      finishedDurationSec: null,

      // result
      status: 'unknown',
      reason: '',
      conflict: false,

      // exact evidence
      fieldSources: {},
      fieldStates: {}
    };
  }

  // One table defines accepted keys, destination fields and value types.
  const FIELDS = {
    resolved_model_slug: ['resolvedModel', 'string'], default_model_slug: ['defaultModel', 'string'],
    model_slug: ['modelSlug', 'string'], requested_model_experience: ['requestedExperience', 'string'],
    thinking_effort: ['thinkingEffort', 'string'], cluster_region: ['clusterRegion', 'string'],
    region: ['region', 'string'], server_ttfvt_ms: ['serverTtfvt', 'number'],
    fast_convo: ['fastConvo', 'boolean'], warmup_state: ['warmupState', 'string'],
    conduit_prewarmed: ['conduitPrewarmed', 'boolean'], is_first_turn: ['isFirstTurn', 'boolean'],
    resume_with_websockets: ['resumeWithWebsockets', 'boolean'], plan_type: ['planType', 'string'],
    plan_type_bucket: ['planTypeBucket', 'string'], is_autoswitcher_enabled: ['isAutoswitcherEnabled', 'boolean'],
    auto_switcher_race_winner: ['autoSwitcherRaceWinner', 'string'],
    did_auto_switch_to_reasoning: ['didAutoSwitchToReasoning', 'boolean'], model_switcher_deny: ['modelSwitcherDeny', 'array'],
    product_experience: ['productExperience', 'string'], turn_use_case: ['turnUseCase', 'string'],
    turn_mode: ['turnMode', 'string'], tool_name: ['toolName', 'string'], tool_invoked: ['toolInvoked', 'boolean'],
    is_search: ['isSearch', 'boolean'], search_tool_call_count: ['searchToolCallCount', 'number'],
    search_tool_query_types: ['searchToolQueryTypes', 'array'], is_multimodal: ['isMultimodal', 'boolean'],
    did_prompt_contain_image: ['didPromptContainImage', 'boolean'], request_id: ['serverRequestId', 'string'],
    turn_exchange_id: ['turnExchangeId', 'string'], turn_trace_id: ['turnTraceId', 'string'],
    reasoning_start_time: ['reasoningStartTime', 'number'], reasoning_end_time: ['reasoningEndTime', 'number'],
    finished_duration_sec: ['finishedDurationSec', 'number'], conversation_id: ['conversationId', 'string'],
    message_id: ['messageId', 'string']
  };
  const own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  function sensitive(k) { return SENSITIVE_KEYS.has(k.toLowerCase()) || /token|cookie|authorization|credential|password|secret|user.agent/i.test(k); }
  function valueType(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

  function mark(rec, key, val, path, type) {
    rec.fieldSources = rec.fieldSources || {};
    rec.fieldStates = rec.fieldStates || {};
    if (val === undefined) return;
    let state = val === null ? 'null' : val === '' ? 'empty' : 'value';
    if (state === 'value') {
      if (type === 'array') {
        if (!Array.isArray(val) || val.length > 64 || val.some(function (v) { return typeof v !== 'string' || v.length > 256; })) state = 'invalid';
        else val = val.slice();
      } else if (typeof val !== type || (type === 'number' && !Number.isFinite(val)) || (type === 'string' && val.length > 256)) state = 'invalid';
    }
    // Missing or invalid observations cannot erase earlier positive evidence.
    if (state !== 'value' && rec.fieldStates[key] === 'value') return;
    rec.fieldSources[key] = path;
    rec.fieldStates[key] = state;
    rec[key] = state === 'value' ? val : null;
  }

  // Only protocol envelopes are visited; content/parts/tool results/citations are never walked.
  // Patch paths are interpreted for known metadata keys, never replayed into a full message.
  function inspectEvent(obj, rec, diag, state) {
    state = state || {};
    const result = { generation: false, text: false, reasoning: false, complete: false, limited: false };
    const stack = [{ value: obj, path: '', depth: 0 }], seen = new Set();
    let visits = 0;
    function fields(o, path, server) {
      Object.keys(o).slice(0, 256).forEach(function (k) {
        if (sensitive(k)) return;
        const spec = FIELDS[k];
        if (spec && rec) {
          const key = k === 'model_slug' && server ? 'serverModel' : spec[0];
          mark(rec, key, o[k], path ? path + '.' + k : k, spec[1]);
        } else if (server && !KNOWN_META_KEYS.has(k) && diag && typeof diag.addUnknownMetaKey === 'function' && /^[a-zA-Z0-9_.-]{1,80}$/.test(k)) {
          diag.addUnknownMetaKey(k, valueType(o[k]));
        }
      });
    }
    function textObserved(value, channel) {
      if (typeof value !== 'string' || value.length === 0) return;
      if (channel === 'analysis' || channel === 'reasoning') result.reasoning = true;
      else if (channel === 'final' || !channel) result.text = true;
    }
    function message(m, path) {
      const role = m.author && m.author.role;
      state.role = role || null; state.channel = typeof m.channel === 'string' ? m.channel : null;
      // Legacy messages had model directly without author; current metadata needs an assistant role.
      if (rec && (!role || role === 'assistant')) {
        if (own(m, 'id')) mark(rec, 'messageId', m.id, path + '.id', 'string');
        if (own(m, 'conversation_id')) mark(rec, 'conversationId', m.conversation_id, path + '.conversation_id', 'string');
        if (own(m, 'model')) mark(rec, 'messageModel', m.model, path + '.model', 'string');
      }
      if (role !== 'assistant') return;
      if (m.metadata && typeof m.metadata === 'object' && !Array.isArray(m.metadata)) {
        fields(m.metadata, path + '.metadata', false);
        if (rec && own(m.metadata, 'model_slug')) mark(rec, 'messageModel', m.metadata.model_slug, path + '.metadata.model_slug', 'string');
        if (own(m.metadata, 'resolved_model_slug') || own(m.metadata, 'default_model_slug')) result.generation = true;
      }
      const parts = m.content && m.content.parts;
      if (Array.isArray(parts)) parts.slice(0, 128).forEach(function (part) { textObserved(part, state.channel); });
    }
    while (stack.length) {
      const item = stack.pop(), o = item.value, path = item.path;
      if (!o || typeof o !== 'object' || seen.has(o)) continue;
      seen.add(o);
      if (++visits > 256 || item.depth > 12) { result.limited = true; continue; }
      if (Array.isArray(o)) {
        if (o.length > 128) result.limited = true;
        for (let i = Math.min(o.length, 128) - 1; i >= 0; i--) stack.push({ value: o[i], path: path + '[' + i + ']', depth: item.depth + 1 });
        continue;
      }
      const patchPath = typeof o.p === 'string' ? o.p : null;
      if (patchPath && patchPath[0] === '/' && own(o, 'v')) {
        if (patchPath === '/message/author/role') state.role = o.v;
        if (patchPath === '/message/channel') state.channel = o.v;
        if (patchPath === '/message' && o.v && typeof o.v === 'object') message(o.v, path + '.v');
        if (state.role === 'assistant') {
          if (/^\/message\/content\/parts\/\d+$/.test(patchPath)) textObserved(o.v, state.channel);
          if (patchPath === '/message/metadata' && o.v && typeof o.v === 'object') {
            fields(o.v, path + '.v', false);
            if (rec && own(o.v, 'model_slug')) mark(rec, 'messageModel', o.v.model_slug, path + '.v.model_slug', 'string');
          }
          const key = patchPath.slice('/message/metadata/'.length);
          if (patchPath.startsWith('/message/metadata/') && own(FIELDS, key) && rec) {
            const spec = FIELDS[key];
            mark(rec, spec[0], o.v, path ? path + '.v' : 'v', spec[1]);
            if (key === 'model_slug') mark(rec, 'messageModel', o.v, path ? path + '.v' : 'v', 'string');
          }
        }
        // Unrecognized patch values can be arbitrary user/tool content; do not descend into them.
        continue;
      }
      if (typeof o.type === 'string' && GENERATION_MARKERS.indexOf(o.type) !== -1) result.generation = true;
      for (let i = 0; i < GENERATION_MARKERS.length; i++) if (own(o, GENERATION_MARKERS[i])) result.generation = true;
      if (o.type === 'message_stream_complete') result.complete = true;
      if (rec) fields(o, path, false);
      if (o.type === 'server_ste_metadata' && o.metadata && typeof o.metadata === 'object') fields(o.metadata, path ? path + '.metadata' : 'metadata', true);
      else if (o.metadata && typeof o.metadata === 'object' && !Array.isArray(o.metadata)) fields(o.metadata, path ? path + '.metadata' : 'metadata', false);
      if (o.message && typeof o.message === 'object') message(o.message, path ? path + '.message' : 'message');
      if (o.type === 'delta' && o.delta && Array.isArray(o.delta.content)) {
        o.delta.content.slice(0, 128).forEach(function (part) { if (part && part.type === 'text') textObserved(part.text, state.channel); });
      }
      if (o.v && typeof o.v === 'object') stack.push({ value: o.v, path: path ? path + '.v' : 'v', depth: item.depth + 1 });
    }
    return result;
  }

  function isGenerationEvent(obj) { return inspectEvent(obj).generation; }
  function extractFields(obj, rec, diag, state) { return inspectEvent(obj, rec, diag, state); }

  function finalizeTiming(rec) {
    if (rec.reasoningStartTime != null && rec.reasoningEndTime != null) {
      const duration = (rec.reasoningEndTime - rec.reasoningStartTime) * 1000;
      if (Number.isFinite(duration) && duration >= 0) rec.reasoningDurationMs = Math.round(duration);
    }
    if (rec.totalMs == null && rec.startedAt != null && rec.endedAt != null) rec.totalMs = Math.max(0, rec.endedAt - rec.startedAt);
  }

  // 判定：缺字段 → unknown，绝不因单个字段缺失就喊降级
  function judge(rec) {
    const req = rec.requestedModel;
    const res = rec.resolvedModel;
    const srv = rec.serverModel;

    rec.conflict = false;

    if (res && srv && res !== srv) {
      rec.status = 'conflict';
      rec.conflict = true;
      rec.reason = '元数据冲突：resolved=' + res + '，server=' + srv;
      return rec;
    }

    const actual = srv || res || rec.messageModel;

    if (req && actual) {
      if (req === actual) {
        rec.status = 'match';
        rec.reason = '请求模型与实际模型一致：' + req;
      } else {
        rec.status = 'mismatch';
        rec.reason = '请求 ' + req + ' → 实际 ' + actual + '（检测到模型切换/降级；具体原因未确认）';
      }
      return rec;
    }

    if (!req && actual) {
      rec.status = 'unknown';
      rec.reason = '未能从请求体读取请求模型；服务端返回 ' + actual;
      return rec;
    }

    if (req && !actual) {
      rec.status = 'unknown';
      rec.reason = '请求 ' + req + '，但流中缺少 resolved/server 模型字段，证据不足';
      return rec;
    }

    rec.status = 'unknown';
    rec.reason = '请求模型与服务端模型字段均缺失，无法判定';
    return rec;
  }

  function prettyModel(slug) {
    if (!slug) return 'unknown';
    let s = String(slug).replace(/^gpt-/i, '');
    const parts = s.split('-');
    const nums = [];
    let i = 0;
    while (i < parts.length && /^\d+$/.test(parts[i])) { nums.push(parts[i]); i++; }
    const rest = parts.slice(i)
      .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); })
      .join(' ');
    return (nums.length ? nums.join('.') + ' ' : '') + rest;
  }

  function shortBadge(slug) {
    if (!slug) return '?';
    const m = String(slug).match(/(\d+)(?:[^\d]+(\d+))?/);
    if (!m) return String(slug).slice(0, 4);
    let label = m[1] + (m[2] ? '.' + m[2] : '');
    if (/mini/i.test(slug)) label += 'm';
    else if (/nano/i.test(slug)) label += 'n';
    else if (/pro/i.test(slug)) label += 'p';
    return label;
  }

  return {
    GENERATION_MARKERS: GENERATION_MARKERS,
    SENSITIVE_KEYS: SENSITIVE_KEYS,
    createRecord: createRecord,
    extractFields: extractFields,
    isGenerationEvent: isGenerationEvent,
    finalizeTiming: finalizeTiming,
    judge: judge,
    prettyModel: prettyModel,
    shortBadge: shortBadge
  };
});

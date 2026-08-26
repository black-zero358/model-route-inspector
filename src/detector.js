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
    'set_cookie'
  ]);

  // server_ste_metadata.metadata 中已知的字段（用于发现未知 key）
  const KNOWN_META_KEYS = new Set([
    'model_slug', 'cluster_region', 'region', 'server_ttfvt_ms',
    'fast_convo', 'warmup_state', 'conduit_prewarmed', 'is_first_turn',
    'resume_with_websockets',
    'plan_type', 'plan_type_bucket',
    'is_autoswitcher_enabled', 'auto_switcher_race_winner',
    'did_auto_switch_to_reasoning', 'model_switcher_deny',
    'product_experience', 'turn_use_case', 'turn_mode',
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
      fieldSources: {}
    };
  }

  function mark(rec, key, val, path) {
    if (val === null || val === undefined || val === '') return;
    rec[key] = val;
    rec.fieldSources[key] = path;
  }

  // 判断单个已解析事件是否带有 generation stream 特征
  function isGenerationEvent(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.type === 'string' && GENERATION_MARKERS.indexOf(obj.type) !== -1) return true;
    for (let i = 0; i < GENERATION_MARKERS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(obj, GENERATION_MARKERS[i])) return true;
    }
    return false;
  }

  function extractFields(obj, rec, diag) {
    const seen = new Set();

    function addUnknownMeta(k) {
      if (diag && typeof diag.addUnknownMetaKey === 'function') diag.addUnknownMetaKey(k);
    }

    function walk(o, path, inMeta) {
      if (o === null || typeof o !== 'object') return;
      if (seen.has(o)) return;
      seen.add(o);

      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) walk(o[i], path + '[' + i + ']', inMeta);
        return;
      }

      // 权威块：server_ste_metadata
      if (o.type === 'server_ste_metadata' && o.metadata && typeof o.metadata === 'object') {
        const m = o.metadata;
        const metaPath = path ? path + '.metadata' : 'metadata';
        const mkeys = Object.keys(m);
        for (let i = 0; i < mkeys.length; i++) {
          const k = mkeys[i];
          if (SENSITIVE_KEYS.has(k)) continue; // 只识别，不落盘
          const v = m[k];
          const p = metaPath + '.' + k;
          if (!KNOWN_META_KEYS.has(k)) {
            addUnknownMeta(k);
            continue; // 未知 key 不猜测含义，只在诊断里记名字
          }
          switch (k) {
            case 'model_slug': mark(rec, 'serverModel', v, p); break;
            case 'cluster_region': mark(rec, 'clusterRegion', v, p); break;
            case 'region': mark(rec, 'region', v, p); break;
            case 'server_ttfvt_ms': if (typeof v === 'number') mark(rec, 'serverTtfvt', v, p); break;
            case 'fast_convo': mark(rec, 'fastConvo', v, p); break;
            case 'warmup_state': mark(rec, 'warmupState', v, p); break;
            case 'conduit_prewarmed': mark(rec, 'conduitPrewarmed', v, p); break;
            case 'is_first_turn': mark(rec, 'isFirstTurn', v, p); break;
            case 'resume_with_websockets': mark(rec, 'resumeWithWebsockets', v, p); break;
            case 'plan_type': mark(rec, 'planType', v, p); break;
            case 'plan_type_bucket': mark(rec, 'planTypeBucket', v, p); break;
            case 'is_autoswitcher_enabled': mark(rec, 'isAutoswitcherEnabled', v, p); break;
            case 'auto_switcher_race_winner': mark(rec, 'autoSwitcherRaceWinner', v, p); break;
            case 'did_auto_switch_to_reasoning': mark(rec, 'didAutoSwitchToReasoning', v, p); break;
            case 'model_switcher_deny': mark(rec, 'modelSwitcherDeny', v, p); break;
            case 'product_experience': mark(rec, 'productExperience', v, p); break;
            case 'turn_use_case': mark(rec, 'turnUseCase', v, p); break;
            case 'turn_mode': mark(rec, 'turnMode', v, p); break;
            case 'tool_name': mark(rec, 'toolName', v, p); break;
            case 'tool_invoked': mark(rec, 'toolInvoked', v, p); break;
            case 'is_search': mark(rec, 'isSearch', v, p); break;
            case 'search_tool_call_count': mark(rec, 'searchToolCallCount', v, p); break;
            case 'search_tool_query_types': mark(rec, 'searchToolQueryTypes', v, p); break;
            case 'is_multimodal': mark(rec, 'isMultimodal', v, p); break;
            case 'did_prompt_contain_image': mark(rec, 'didPromptContainImage', v, p); break;
            case 'request_id': mark(rec, 'serverRequestId', v, p); break;
            case 'turn_exchange_id': mark(rec, 'turnExchangeId', v, p); break;
            case 'turn_trace_id': mark(rec, 'turnTraceId', v, p); break;
            case 'reasoning_start_time': if (typeof v === 'number') mark(rec, 'reasoningStartTime', v, p); break;
            case 'reasoning_end_time': if (typeof v === 'number') mark(rec, 'reasoningEndTime', v, p); break;
            case 'finished_duration_sec': if (typeof v === 'number') mark(rec, 'finishedDurationSec', v, p); break;
            case 'conversation_id': mark(rec, 'conversationId', v, p); break;
            case 'message_id': mark(rec, 'messageId', v, p); break;
            default: break;
          }
        }
      }

      const keys = Object.keys(o);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (SENSITIVE_KEYS.has(k)) continue;
        const v = o[k];
        const p = path ? path + '.' + k : k;

        if (typeof v === 'string') {
          switch (k) {
            case 'resolved_model_slug': mark(rec, 'resolvedModel', v, p); break;
            case 'default_model_slug': mark(rec, 'defaultModel', v, p); break;
            case 'model_slug':
              if (!p.endsWith('.metadata.model_slug')) mark(rec, 'modelSlug', v, p);
              break;
            case 'requested_model_experience': mark(rec, 'requestedExperience', v, p); break;
            case 'thinking_effort': mark(rec, 'thinkingEffort', v, p); break;
            case 'cluster_region': mark(rec, 'clusterRegion', v, p); break;
            case 'warmup_state': mark(rec, 'warmupState', v, p); break;
            case 'product_experience': mark(rec, 'productExperience', v, p); break;
            case 'turn_use_case': mark(rec, 'turnUseCase', v, p); break;
            case 'turn_mode': mark(rec, 'turnMode', v, p); break;
            case 'plan_type': mark(rec, 'planType', v, p); break;
            case 'plan_type_bucket': mark(rec, 'planTypeBucket', v, p); break;
            case 'tool_name': mark(rec, 'toolName', v, p); break;
            case 'region': mark(rec, 'region', v, p); break;
            case 'request_id': mark(rec, 'serverRequestId', v, p); break;
            case 'turn_exchange_id': mark(rec, 'turnExchangeId', v, p); break;
            case 'turn_trace_id': mark(rec, 'turnTraceId', v, p); break;
            case 'conversation_id': mark(rec, 'conversationId', v, p); break;
            case 'message_id': mark(rec, 'messageId', v, p); break;
            default: break;
          }
        } else if (typeof v === 'number') {
          switch (k) {
            case 'server_ttfvt_ms': mark(rec, 'serverTtfvt', v, p); break;
            case 'reasoning_start_time': mark(rec, 'reasoningStartTime', v, p); break;
            case 'reasoning_end_time': mark(rec, 'reasoningEndTime', v, p); break;
            case 'finished_duration_sec': mark(rec, 'finishedDurationSec', v, p); break;
            default: break;
          }
        } else if (typeof v === 'boolean') {
          switch (k) {
            case 'did_auto_switch_to_reasoning': mark(rec, 'didAutoSwitchToReasoning', v, p); break;
            case 'is_autoswitcher_enabled': mark(rec, 'isAutoswitcherEnabled', v, p); break;
            case 'fast_convo': mark(rec, 'fastConvo', v, p); break;
            case 'conduit_prewarmed': mark(rec, 'conduitPrewarmed', v, p); break;
            case 'is_first_turn': mark(rec, 'isFirstTurn', v, p); break;
            case 'resume_with_websockets': mark(rec, 'resumeWithWebsockets', v, p); break;
            case 'tool_invoked': mark(rec, 'toolInvoked', v, p); break;
            case 'is_search': mark(rec, 'isSearch', v, p); break;
            case 'is_multimodal': mark(rec, 'isMultimodal', v, p); break;
            case 'did_prompt_contain_image': mark(rec, 'didPromptContainImage', v, p); break;
            default: break;
          }
        } else if (Array.isArray(v)) {
          if (k === 'model_switcher_deny') mark(rec, 'modelSwitcherDeny', v, p);
          else if (k === 'search_tool_query_types') mark(rec, 'searchToolQueryTypes', v, p);
        } else if (v !== null && typeof v === 'object') {
          if (k === 'auto_switcher_race_winner') mark(rec, 'autoSwitcherRaceWinner', v, p);
        }

        // message 对象兜底
        if (k === 'message' && v && typeof v === 'object') {
          if (typeof v.id === 'string') mark(rec, 'messageId', v.id, p + '.id');
          if (typeof v.conversation_id === 'string') mark(rec, 'conversationId', v.conversation_id, p + '.conversation_id');
          if (typeof v.model === 'string') mark(rec, 'messageModel', v.model, p + '.model');
        }

        if (v !== null && typeof v === 'object') walk(v, p, inMeta || (k === 'metadata'));
      }
    }

    walk(obj, '', false);
  }

  function finalizeTiming(rec) {
    if (rec.reasoningStartTime != null && rec.reasoningEndTime != null) {
      rec.reasoningDurationMs = Math.round((rec.reasoningEndTime - rec.reasoningStartTime) * 1000);
    }
    if (rec.startedAt && rec.endedAt) rec.totalMs = rec.endedAt - rec.startedAt;
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
        rec.reason = '请求 ' + req + ' → 实际 ' + actual + '（检测到模型切换/降级）';
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

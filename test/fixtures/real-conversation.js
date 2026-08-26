/*
 * test/fixtures/real-conversation.js
 *
 * 基于真实 ChatGPT /backend-api/f/conversation 响应的字段结构构造的 fixture。
 * 所有 ID / token / 正文均为伪造，只保留字段名与结构，用于回归测试。
 */

const responseCreated = {
  type: 'response_created',
  conversation_id: 'conv-fixture-0001',
  model_slug: 'gpt-5-6-thinking',
  default_model_slug: 'gpt-5-5-mini',
  resolved_model_slug: 'gpt-5-6-thinking',
  requested_model_experience: 'thinking',
  thinking_effort: 'extended',
  delta_encoding: 'roles',
  resume_conversation_token: 'FAKE.SENSITIVE.TOKEN_MUST_NOT_BE_SAVED',
  message: {
    id: 'msg-fixture-0001',
    conversation_id: 'conv-fixture-0001',
    model: 'gpt-5-6-thinking',
    status: 'in_progress'
  }
};

const delta1 = {
  type: 'delta',
  delta: { content: [{ type: 'text', text: 'FAKE_ASSISTANT_TEXT_NOT_STORED' }] },
  message_marker: { message_id: 'msg-fixture-0001' }
};

const serverSteMetadata = {
  type: 'server_ste_metadata',
  metadata: {
    model_slug: 'gpt-5-6-thinking',
    cluster_region: 'japaneast',
    region: null,
    server_ttfvt_ms: 1644.749,
    fast_convo: true,
    warmup_state: 'rewarm',
    conduit_prewarmed: false,
    is_first_turn: false,
    resume_with_websockets: true,
    plan_type: 'plus',
    plan_type_bucket: 'paid',
    is_autoswitcher_enabled: false,
    auto_switcher_race_winner: null,
    did_auto_switch_to_reasoning: false,
    model_switcher_deny: [],
    product_experience: 'chat',
    turn_use_case: 'text',
    turn_mode: 'default',
    tool_name: null,
    tool_invoked: false,
    is_search: null,
    search_tool_call_count: null,
    search_tool_query_types: null,
    is_multimodal: null,
    did_prompt_contain_image: false,
    request_id: 'req-fixture-0001',
    turn_exchange_id: 'exchange-fixture-0001',
    turn_trace_id: 'trace-fixture-0001',
    reasoning_start_time: 1787715654.195767,
    reasoning_end_time: 1787715654.7835362,
    finished_duration_sec: 0,
    a32e6ebcb: 11
  }
};

const delta2 = {
  type: 'delta',
  delta: { content: [{ type: 'text', text: 'MORE_FAKE_TEXT' }] }
};

const streamComplete = {
  type: 'message_stream_complete',
  message_id: 'msg-fixture-0001',
  conversation_id: 'conv-fixture-0001'
};

const detailMeta = {
  type: 'conversation_detail_metadata',
  conversation_id: 'conv-fixture-0001'
};

const events = [responseCreated, delta1, serverSteMetadata, delta2, streamComplete, detailMeta];

function toSSE() {
  return events.map(function (e) {
    return 'data: ' + JSON.stringify(e) + '\n\n';
  }).join('') + 'data: [DONE]\n\n';
}

module.exports = {
  events: events,
  sse: toSSE(),
  requestedModel: 'gpt-5-6-thinking',
  expected: {
    conversationId: 'conv-fixture-0001',
    messageId: 'msg-fixture-0001',
    serverRequestId: 'req-fixture-0001',
    turnExchangeId: 'exchange-fixture-0001',
    turnTraceId: 'trace-fixture-0001',
    requestedModel: 'gpt-5-6-thinking',
    defaultModel: 'gpt-5-5-mini',
    resolvedModel: 'gpt-5-6-thinking',
    serverModel: 'gpt-5-6-thinking',
    messageModel: 'gpt-5-6-thinking',
    requestedExperience: 'thinking',
    thinkingEffort: 'extended',
    isAutoswitcherEnabled: false,
    didAutoSwitchToReasoning: false,
    autoSwitcherRaceWinner: null,
    modelSwitcherDeny: [],
    planType: 'plus',
    planTypeBucket: 'paid',
    productExperience: 'chat',
    turnMode: 'default',
    turnUseCase: 'text',
    fastConvo: true,
    warmupState: 'rewarm',
    conduitPrewarmed: false,
    isFirstTurn: false,
    clusterRegion: 'japaneast',
    serverTtfvt: 1644.749,
    resumeWithWebsockets: true,
    toolInvoked: false,
    reasoningStartTime: 1787715654.195767,
    reasoningEndTime: 1787715654.7835362,
    unknownMetaKey: 'a32e6ebcb'
  }
};

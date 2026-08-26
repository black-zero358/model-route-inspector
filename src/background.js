/*
 * background.js — service worker
 *  - 接收 content script 转发的路由记录
 *  - 写入 chrome.storage.local（最近 1000 轮）
 *  - 维护统计、更新工具栏徽章
 *  - 模型切换时发送系统通知
 *  - 响应 popup 的查询 / 导出 / 清空 / 设置请求
 */
importScripts('parser.js', 'detector.js');

const MRI = self.__MRI__ || {};
const shortBadge = MRI.shortBadge || function (s) { return s ? String(s).slice(0, 4) : '?'; };
const prettyModel = MRI.prettyModel || function (s) { return s || 'unknown'; };

const MAX_RECORDS = 1000;
const STORE_KEYS = {
  RECORDS: 'records',
  STATS: 'stats',
  SETTINGS: 'settings'
};

const BADGE_COLORS = {
  match: '#16a34a',
  mismatch: '#dc2626',
  unknown: '#ca8a04',
  conflict: '#ea580c'
};

const DEFAULT_SETTINGS = {
  floatingEnabled: true,
  notifyOnMismatch: true
};

const DEFAULT_STATS = {
  totalRequests: 0,
  mismatchCount: 0,
  conflictCount: 0,
  unknownCount: 0,
  matchCount: 0,
  modelCounts: {},
      lastModel: null,
  lastConversationId: null
};

function nowTs() { return Date.now(); }

function getStore(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
  });
}
function setStore(obj) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(obj, function () { resolve(); });
  });
}

async function getSettings() {
  const r = await getStore(STORE_KEYS.SETTINGS);
  return Object.assign({}, DEFAULT_SETTINGS, r[STORE_KEYS.SETTINGS] || {});
}

async function getStats() {
  const r = await getStore(STORE_KEYS.STATS);
  return Object.assign({}, DEFAULT_STATS, r[STORE_KEYS.STATS] || {});
}

function updateBadge(rec) {
  try {
    const actual = rec.serverModel || rec.resolvedModel || rec.requestedModel || rec.modelSlug;
    const text = shortBadge(actual);
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[rec.status] || '#555' });
    const title = 'Model Route Inspector\n' +
      (actual ? prettyModel(actual) : 'unknown') + '\n' +
      (rec.reason || rec.status);
    chrome.action.setTitle({ title: title });
  } catch (_) { /* ignore */ }
}

async function maybeNotify(rec, settings, stats) {
  if (!settings.notifyOnMismatch) return;
  if (rec.status !== 'mismatch') return;
  // “仅模型发生变化时通知”：与上一轮实际模型不同才通知
  const actual = rec.serverModel || rec.resolvedModel;
  if (stats.lastModel && actual && stats.lastModel === actual) return;
  try {
    chrome.notifications.create('mri_' + rec.requestId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'ChatGPT 模型切换',
      message: prettyModel(rec.requestedModel) + ' → ' + prettyModel(actual),
      priority: 2
    });
  } catch (_) { /* ignore */ }
}

async function handleRecord(rec) {
  // 安全：只保留路由元数据，剔除任何可能夹带的正文字段
  const safe = sanitizeRecord(rec);
  safe.timestamp = safe.endedAt || safe.startedAt || nowTs();

  const store = await getStore([STORE_KEYS.RECORDS, STORE_KEYS.STATS, STORE_KEYS.SETTINGS]);
  const records = Array.isArray(store[STORE_KEYS.RECORDS]) ? store[STORE_KEYS.RECORDS] : [];
  const stats = Object.assign({}, DEFAULT_STATS, store[STORE_KEYS.STATS] || {});
  const settings = Object.assign({}, DEFAULT_SETTINGS, store[STORE_KEYS.SETTINGS] || {});

  records.push(safe);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);

  stats.totalRequests++;
  if (safe.status === 'match') stats.matchCount++;
  else if (safe.status === 'mismatch') stats.mismatchCount++;
  else if (safe.status === 'conflict') stats.conflictCount++;
  else stats.unknownCount++;

  const actualKey = safe.serverModel || safe.resolvedModel || safe.messageModel || safe.requestedModel || safe.modelSlug || 'unknown';
  stats.modelCounts[actualKey] = (stats.modelCounts[actualKey] || 0) + 1;
  stats.lastModel = actualKey;
  stats.lastConversationId = safe.conversationId;

  await setStore({
    records: records,
    stats: stats,
    settings: settings
  });

  updateBadge(safe);
  maybeNotify(safe, settings, stats);
}

// 白名单：只保存模型路由/调度/传输相关元数据，绝不保存正文与凭据
const ALLOWED_FIELDS = [
  // identity
  'requestId', 'url', 'endpoint', 'startedAt', 'endedAt', 'timestamp',
  'conversationId', 'messageId', 'serverRequestId', 'turnExchangeId', 'turnTraceId',
  // routing
  'requestedModel', 'defaultModel', 'resolvedModel', 'serverModel', 'messageModel', 'modelSlug',
  'requestedExperience', 'thinkingEffort',
  'isAutoswitcherEnabled', 'didAutoSwitchToReasoning', 'autoSwitcherRaceWinner', 'modelSwitcherDeny',
  // product / account
  'planType', 'planTypeBucket', 'productExperience', 'turnMode', 'turnUseCase',
  // serving
  'fastConvo', 'warmupState', 'conduitPrewarmed', 'isFirstTurn',
  // infrastructure
  'clusterRegion', 'region', 'serverTtfvt',
  // transport
  'transport', 'responseStatus', 'contentType', 'resumeWithWebsockets',
  // task
  'toolInvoked', 'toolName', 'isSearch', 'searchToolCallCount', 'searchToolQueryTypes',
  'isMultimodal', 'didPromptContainImage',
  // timing
  'firstByteMs', 'firstDeltaMs', 'totalMs',
  'reasoningStartTime', 'reasoningEndTime', 'reasoningDurationMs', 'finishedDurationSec',
  // result
  'status', 'reason', 'conflict', 'fieldSources', 'aborted'
];

function sanitizeRecord(rec) {
  const out = {};
  if (!rec || typeof rec !== 'object') return out;
  for (let i = 0; i < ALLOWED_FIELDS.length; i++) {
    const k = ALLOWED_FIELDS[i];
    if (rec[k] !== undefined) out[k] = rec[k];
  }
  return out;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function recordsToCsv(records) {
  const headers = [
    'timestamp', 'status', 'endpoint', 'responseStatus',
    'requestedModel', 'resolvedModel', 'serverModel', 'messageModel', 'defaultModel',
    'requestedExperience', 'productExperience', 'turnMode', 'turnUseCase',
    'thinkingEffort', 'isAutoswitcherEnabled', 'didAutoSwitchToReasoning',
    'fastConvo', 'warmupState', 'conduitPrewarmed', 'isFirstTurn',
    'planType', 'planTypeBucket',
    'clusterRegion', 'region', 'serverTtfvt',
    'transport', 'resumeWithWebsockets',
    'toolInvoked', 'toolName', 'isSearch', 'isMultimodal', 'didPromptContainImage',
    'firstByteMs', 'firstDeltaMs', 'totalMs', 'reasoningDurationMs',
    'conversationId', 'messageId', 'serverRequestId', 'turnTraceId',
    'reason'
  ];
  const lines = [headers.join(',')];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const row = headers.map(function (h) {
      if (h === 'timestamp') return new Date(r[h] || r.endedAt || r.startedAt || Date.now()).toISOString();
      return csvEscape(r[h]);
    });
    lines.push(row.join(','));
  }
  return lines.join('\r\n');
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'mri-record') {
    handleRecord(msg.record).catch(function (e) { console.warn('MRI handleRecord error', e); });
    return; // 异步，无需 sendResponse
  }

  if (msg.type === 'mri-content-ready') {
    // 把当前悬浮卡设置同步给 content script
    getSettings().then(function (s) {
      try {
        chrome.tabs.sendMessage(sender.tab.id, {
          target: 'mri-content', type: 'mri-floating-setting', enabled: s.floatingEnabled
        }, function () { void chrome.runtime.lastError; });
      } catch (_) { /* ignore */ }
    });
    return;
  }

  if (msg.type === 'mri-disable-floating') {
    getSettings().then(function (s) {
      s.floatingEnabled = false;
      setStore({ settings: s });
    });
    return;
  }

  if (msg.type === 'mri-get-data') {
    Promise.all([
      getStore([STORE_KEYS.RECORDS, STORE_KEYS.STATS]),
      getSettings()
    ]).then(function (res) {
      const data = res[0];
      sendResponse({
        records: data[STORE_KEYS.RECORDS] || [],
        stats: Object.assign({}, DEFAULT_STATS, data[STORE_KEYS.STATS] || {}),
        settings: res[1]
      });
    });
    return true; // 异步响应
  }

  if (msg.type === 'mri-clear') {
    setStore({ records: [], stats: Object.assign({}, DEFAULT_STATS) }).then(function () {
      chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'mri-set-floating') {
    getSettings().then(function (s) {
      s.floatingEnabled = !!msg.enabled;
      setStore({ settings: s }).then(function () {
        // 广播给所有 ChatGPT 标签页
        chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }, function (tabs) {
          tabs.forEach(function (t) {
            chrome.tabs.sendMessage(t.id, {
              target: 'mri-content', type: 'mri-floating-setting', enabled: s.floatingEnabled
            }, function () { void chrome.runtime.lastError; });
          });
        });
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg.type === 'mri-export-json') {
    getStore([STORE_KEYS.RECORDS, STORE_KEYS.STATS]).then(function (data) {
      sendResponse({
        json: JSON.stringify({
          exportedAt: new Date().toISOString(),
          records: data[STORE_KEYS.RECORDS] || [],
          stats: Object.assign({}, DEFAULT_STATS, data[STORE_KEYS.STATS] || {})
        }, null, 2)
      });
    });
    return true;
  }

  if (msg.type === 'mri-export-csv') {
    getStore([STORE_KEYS.RECORDS]).then(function (data) {
      sendResponse({ csv: recordsToCsv(data[STORE_KEYS.RECORDS] || []) });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get([STORE_KEYS.SETTINGS, STORE_KEYS.STATS], function (res) {
    const patch = {};
    if (!res[STORE_KEYS.SETTINGS]) patch[STORE_KEYS.SETTINGS] = DEFAULT_SETTINGS;
    if (!res[STORE_KEYS.STATS]) patch[STORE_KEYS.STATS] = DEFAULT_STATS;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
});

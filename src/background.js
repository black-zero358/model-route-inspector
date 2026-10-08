/* Service worker: bounded metadata storage, serialized mutations and popup queries. */
'use strict';
importScripts('detector.js');
const MRI = self.__MRI__ || {};
const MAX_RECORDS = 1000;
const DEFAULT_SETTINGS = { floatingEnabled: true, notifyOnMismatch: true };
const BADGE_COLORS = { match: '#16a34a', mismatch: '#dc2626', unknown: '#ca8a04', conflict: '#ea580c' };
const STATUS_KEYS = { match: 'matchCount', mismatch: 'mismatchCount', conflict: 'conflictCount', unknown: 'unknownCount' };
const NUMBER_FIELDS = new Set(('startedAt endedAt timestamp responseStatus serverTtfvt searchToolCallCount firstByteMs firstDeltaMs totalMs responseHeadersMs firstTextMs firstReasoningMs completionMs reasoningStartTime reasoningEndTime reasoningDurationMs finishedDurationSec').split(' '));
const BOOLEAN_FIELDS = new Set(('isAutoswitcherEnabled didAutoSwitchToReasoning fastConvo conduitPrewarmed isFirstTurn resumeWithWebsockets toolInvoked isSearch isMultimodal didPromptContainImage conflict aborted streamComplete transportCanceled').split(' '));
const STRING_FIELDS = new Set(('requestId conversationId messageId serverRequestId turnExchangeId turnTraceId requestedModel defaultModel resolvedModel serverModel messageModel modelSlug requestedExperience thinkingEffort autoSwitcherRaceWinner planType planTypeBucket productExperience turnMode turnUseCase warmupState clusterRegion region transport contentType status reason cancelReason timingSource toolName').split(' '));
const ARRAY_FIELDS = new Set(['modelSwitcherDeny', 'searchToolQueryTypes', 'completionSignals']);
const ALLOWED_FIELDS = new Set([...NUMBER_FIELDS, ...BOOLEAN_FIELDS, ...STRING_FIELDS, ...ARRAY_FIELDS, 'url', 'endpoint', 'captureLimited']);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const prettyModel = MRI.prettyModel || (value => value || 'unknown');
function freshStats() {
  return { totalRequests: 0, mismatchCount: 0, conflictCount: 0, unknownCount: 0, matchCount: 0, modelCounts: Object.create(null), lastModel: null, lastConversationId: null };
}
function settingsOf(value) {
  const result = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(result)) if (value && typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}
function statsOf(value) {
  const result = freshStats();
  if (!value || typeof value !== 'object') return result;
  for (const key of ['totalRequests', ...Object.values(STATUS_KEYS)]) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  for (const [key, count] of Object.entries(value.modelCounts || {})) if (key.length <= 256 && Number.isSafeInteger(count) && count >= 0) result.modelCounts[key] = count;
  for (const key of ['lastModel', 'lastConversationId']) if (typeof value[key] === 'string') result[key] = value[key].slice(0, 256);
  return result;
}
// Clear, export, settings and incoming records share one operation ordering.
// Failure is returned to the caller and must not poison the next queued operation.
let storeQueue = Promise.resolve();
function serialized(task) {
  const result = storeQueue.then(task);
  storeQueue = result.catch(() => {});
  return result;
}
function storage(method, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local[method](value, result => {
      if (chrome.runtime.lastError) reject(new Error('storage-unavailable'));
      else resolve(result || {});
    });
  });
}
function safePath(value, absolute) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const parsed = new URL(value, 'https://chatgpt.com');
    if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(parsed.origin)) return null;
    // Drop query/hash and identifier-bearing paths; routing does not need them.
    const match = parsed.pathname.match(/^\/backend-api\/(?:(?:f|v\d+(?:\.\d+)*)\/){0,2}(?:conversation(?:\/prepare|\/init)?|stop_conversation)\/?$/);
    return match ? (absolute ? parsed.origin : '') + parsed.pathname : null;
  } catch (_) { return null; }
}
function sanitizeRecord(record) {
  const result = {};
  if (!record || typeof record !== 'object' || Array.isArray(record)) return result;
  for (const key of ALLOWED_FIELDS) {
    if (!own(record, key)) continue;
    const value = record[key];
    if (value === null) { result[key] = null; continue; }
    if (NUMBER_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') result[key] = value;
    else if (STRING_FIELDS.has(key) && typeof value === 'string' && value.length <= 256) result[key] = value;
    else if (ARRAY_FIELDS.has(key) && Array.isArray(value)) {
      result[key] = value.slice(0, 32).filter(item => typeof item === 'string' && item.length <= 128);
      if (key === 'completionSignals') result[key] = result[key].filter(item => item === '[DONE]' || item === 'message_stream_complete');
    } else if (key === 'captureLimited' && (typeof value === 'boolean' || typeof value === 'string' && value.length <= 128)) result[key] = value;
    else if (key === 'url' || key === 'endpoint') result[key] = safePath(value, key === 'url');
  }
  for (const key of ['fieldSources', 'fieldStates']) {
    const map = record[key];
    result[key] = {};
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const field of ALLOWED_FIELDS) {
      if (!own(map, field) || typeof map[field] !== 'string') continue;
      const value = map[field];
      if (key === 'fieldStates' ? ['value', 'null', 'empty', 'invalid'].includes(value) : value.length <= 256 && /^[a-zA-Z0-9_.$/[\]-]+$/.test(value)) result[key][field] = value;
    }
  }
  if (!own(STATUS_KEYS, result.status)) result.status = 'unknown';
  return result;
}
function historyOf(value) { return Array.isArray(value) ? value.slice(-MAX_RECORDS).map(sanitizeRecord) : []; }
function consumeApiError() { void chrome.runtime.lastError; }
function updateBadge(record) {
  const actual = record.serverModel || record.resolvedModel || record.messageModel || record.requestedModel || record.modelSlug;
  chrome.action.setBadgeText({ text: MRI.shortBadge ? MRI.shortBadge(actual) : (actual || '?').slice(0, 4) }, consumeApiError);
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[record.status] || '#555' }, consumeApiError);
  chrome.action.setTitle({ title: 'Model Route Inspector\n' + prettyModel(actual) + '\n' + (record.reason || record.status) }, consumeApiError);
}
function maybeNotify(record, settings, previousModel) {
  const actual = record.serverModel || record.resolvedModel;
  if (!settings.notifyOnMismatch || record.status !== 'mismatch' || !actual || previousModel === actual) return;
  chrome.notifications.create('mri_' + record.requestId, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'ChatGPT 模型切换', message: prettyModel(record.requestedModel) + ' → ' + prettyModel(actual), priority: 2 }, consumeApiError);
}
async function handleRecord(record) {
  const safe = sanitizeRecord(record);
  if (!safe.requestId || !safe.endpoint) throw new Error('invalid-record');
  safe.timestamp = safe.endedAt || safe.startedAt || Date.now();
  const data = await storage('get', ['records', 'stats', 'settings']);
  const records = historyOf(data.records);
  if (records.some(item => item.requestId === safe.requestId)) return { ok: true, duplicate: true };
  const stats = statsOf(data.stats), previousModel = stats.lastModel, settings = settingsOf(data.settings);
  records.push(safe);
  if (records.length > MAX_RECORDS) records.shift();
  stats.totalRequests++;
  stats[STATUS_KEYS[safe.status]]++;
  const actual = safe.serverModel || safe.resolvedModel || safe.messageModel || safe.requestedModel || safe.modelSlug || 'unknown';
  stats.modelCounts[actual] = (stats.modelCounts[actual] || 0) + 1;
  // Notification comparison requires actual routing evidence, not a Requested fallback.
  stats.lastModel = safe.serverModel || safe.resolvedModel || null;
  stats.lastConversationId = safe.conversationId || null;
  await storage('set', { records, stats });
  updateBadge(safe);
  maybeNotify(safe, settings, previousModel);
  return { ok: true };
}
function broadcastFloating(enabled) {
  chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] }, tabs => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs || []) chrome.tabs.sendMessage(tab.id, { target: 'mri-content', type: 'mri-floating-setting', enabled }, consumeApiError);
  });
}
async function setFloating(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('invalid-setting');
  const data = await storage('get', ['settings']);
  const settings = settingsOf(data.settings);
  settings.floatingEnabled = enabled;
  await storage('set', { settings });
  broadcastFloating(enabled);
  return { ok: true };
}
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let text = Array.isArray(value) ? value.join(';') : String(value);
  // Quoting alone does not stop spreadsheet formula execution.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function recordsToCsv(records) {
  const headers = ['timestamp', 'status', 'endpoint', 'responseStatus', 'requestedModel', 'resolvedModel', 'serverModel', 'messageModel', 'defaultModel', 'requestedExperience', 'productExperience', 'turnMode', 'turnUseCase', 'thinkingEffort', 'isAutoswitcherEnabled', 'didAutoSwitchToReasoning', 'fastConvo', 'warmupState', 'conduitPrewarmed', 'isFirstTurn', 'planType', 'planTypeBucket', 'clusterRegion', 'region', 'serverTtfvt', 'transport', 'resumeWithWebsockets', 'toolInvoked', 'toolName', 'isSearch', 'isMultimodal', 'didPromptContainImage', 'responseHeadersMs', 'firstByteMs', 'firstDeltaMs', 'firstTextMs', 'firstReasoningMs', 'completionMs', 'totalMs', 'reasoningDurationMs', 'streamComplete', 'completionSignals', 'transportCanceled', 'cancelReason', 'captureLimited', 'conversationId', 'messageId', 'serverRequestId', 'turnTraceId', 'reason'];
  return [headers.join(','), ...records.map(record => headers.map(key => {
    if (key !== 'timestamp') return csvEscape(record[key]);
    const date = new Date(record.timestamp || record.endedAt || record.startedAt || 0);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }).join(','))].join('\r\n');
}
function isChatSender(sender) {
  if (!sender || !sender.tab || sender.frameId && sender.frameId !== 0) return false;
  try { return ['https://chatgpt.com', 'https://chat.openai.com'].includes(new URL(sender.url || sender.tab.url).origin); }
  catch (_) { return false; }
}
function isPopupSender(sender) { return !!sender && sender.url === chrome.runtime.getURL('src/popup.html'); }
const CONTENT_MESSAGES = new Set(['mri-record', 'mri-content-ready', 'mri-disable-floating']);
const POPUP_MESSAGES = new Set(['mri-get-data', 'mri-clear', 'mri-set-floating', 'mri-export-json', 'mri-export-csv']);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (!CONTENT_MESSAGES.has(message.type) && !POPUP_MESSAGES.has(message.type)) return;
  if (!sender || sender.id !== chrome.runtime.id || !(CONTENT_MESSAGES.has(message.type) ? isChatSender(sender) : isPopupSender(sender))) { sendResponse({ ok: false, error: 'unauthorized-sender' }); return; }
  serialized(async () => {
    if (message.type === 'mri-record') return handleRecord(message.record);
    if (message.type === 'mri-disable-floating' || message.type === 'mri-set-floating') return setFloating(message.type === 'mri-disable-floating' ? false : message.enabled);
    if (message.type === 'mri-clear') {
      await storage('set', { records: [], stats: freshStats() });
      chrome.action.setBadgeText({ text: '' }, consumeApiError);
      chrome.action.setTitle({ title: 'Model Route Inspector' }, consumeApiError);
      return { ok: true };
    }
    const data = await storage('get', ['records', 'stats', 'settings']);
    if (message.type === 'mri-content-ready') {
      chrome.tabs.sendMessage(sender.tab.id, { target: 'mri-content', type: 'mri-floating-setting', enabled: settingsOf(data.settings).floatingEnabled }, consumeApiError);
      return { ok: true };
    }
    const records = historyOf(data.records), stats = statsOf(data.stats);
    if (message.type === 'mri-export-csv') return { ok: true, csv: recordsToCsv(records) };
    if (message.type === 'mri-export-json') return { ok: true, json: JSON.stringify({ exportedAt: new Date().toISOString(), records, stats }, null, 2) };
    return { ok: true, records, stats, settings: settingsOf(data.settings) };
  }).then(sendResponse, error => sendResponse({ ok: false, error: ['invalid-record', 'invalid-setting'].includes(error.message) ? error.message : 'storage-unavailable' }));
  return true;
});
// Content scripts use the checked message bridge instead of direct history access.
if (chrome.storage.local.setAccessLevel) chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }, consumeApiError);
chrome.runtime.onInstalled.addListener(() => {
  serialized(async () => {
    const data = await storage('get', ['settings', 'stats', 'records']);
    await storage('set', { settings: settingsOf(data.settings), stats: statsOf(data.stats), records: historyOf(data.records) });
  }).catch(() => console.warn('MRI storage initialization failed'));
});

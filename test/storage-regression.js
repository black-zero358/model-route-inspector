/* Synthetic storage/service-worker regression; no browser profile or chat data. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceRoot = path.resolve(__dirname, '../src');
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
const copy = value => structuredClone(value);
const record = (id, extra = {}) => ({ requestId: 'synthetic-' + id, endpoint: '/backend-api/f/conversation', url: 'https://chatgpt.com/backend-api/f/conversation', requestedModel: 'gpt-6', resolvedModel: 'gpt-6', serverModel: 'gpt-6', status: 'match', startedAt: 1000, endedAt: 2000, ...extra });
function harness(initial = {}) {
  let data = copy(initial), onMessage, onInstalled, failNext;
  const notifications = [], badges = [], broadcasts = [], access = [];
  const runtime = { id: 'synthetic-extension', getURL: value => 'chrome-extension://synthetic-extension/' + value, onMessage: { addListener: fn => { onMessage = fn; } }, onInstalled: { addListener: fn => { onInstalled = fn; } } };
  const callback = (fn, value, failure) => setImmediate(() => {
    if (failure) runtime.lastError = { message: 'synthetic failure (never copied to user)' };
    fn?.(value); delete runtime.lastError;
  });
  const context = { console, URL, Date, Promise, Object, Array, String, JSON, Math, Number, Set };
  context.self = context;
  context.chrome = {
    runtime, storage: { local: {
      get: (keys, cb) => { const result = copy(data), failure = failNext === 'get'; if (failure) failNext = null; callback(cb, result, failure); },
      set: (patch, cb) => { const failure = failNext === 'set'; if (failure) failNext = null; else Object.assign(data, copy(patch)); callback(cb, undefined, failure); },
      setAccessLevel: (setting, cb) => { access.push(setting); callback(cb); }
    } },
    action: { setBadgeText: (value, cb) => { badges.push(value.text); callback(cb); }, setBadgeBackgroundColor: (_, cb) => callback(cb), setTitle: (_, cb) => callback(cb) },
    notifications: { create: (id, options, cb) => { notifications.push({ id, ...options }); callback(cb); } },
    tabs: { query: (_, cb) => callback(cb, [{ id: 1 }]), sendMessage: (id, message, cb) => { broadcasts.push({ id, message }); callback(cb); } }
  };
  vm.createContext(context);
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'background.js'), 'utf8'), context);
  const chat = { id: runtime.id, tab: { id: 1, url: 'https://chatgpt.com/' }, url: 'https://chatgpt.com/', frameId: 0 };
  const popup = { id: runtime.id, url: runtime.getURL('src/popup.html') };
  return {
    send: (message, sender = ['mri-record', 'mri-content-ready', 'mri-disable-floating'].includes(message.type) ? chat : popup) => new Promise(resolve => { onMessage(message, sender, resolve); }),
    raw: message => new Promise(resolve => onMessage(message, chat, resolve)),
    state: () => copy(data), fail: method => { failNext = method; }, installed: () => onInstalled(), notifications, badges, broadcasts, access
  };
}
(async () => {
  {
    const h = harness();
    const responses = await Promise.all(Array.from({ length: 25 }, (_, index) => h.send({ type: 'mri-record', record: record(index) })));
    const state = h.state();
    check('25 concurrent messages persist all histories and stats', responses.every(result => result.ok) && state.records.length === 25 && state.stats.totalRequests === 25 && state.stats.matchCount === 25 && state.stats.modelCounts['gpt-6'] === 25);
    const duplicate = await h.send({ type: 'mri-record', record: record(0) });
    check('duplicate record does not inflate history/statistics', duplicate.duplicate && h.state().stats.totalRequests === 25);
    check('local history access restricted to trusted contexts', h.access[0].accessLevel === 'TRUSTED_CONTEXTS');
  }
  {
    const h = harness();
    await Promise.all([
      h.send({ type: 'mri-record', record: record(1) }), h.send({ type: 'mri-clear' }),
      h.send({ type: 'mri-set-floating', enabled: false }), h.send({ type: 'mri-record', record: record(2) }),
      h.send({ type: 'mri-get-data' })
    ]);
    check('clear/record/settings race respects received order', h.state().records.length === 1 && h.state().records[0].requestId === 'synthetic-2' && h.state().stats.totalRequests === 1 && h.state().settings.floatingEnabled === false);
    await h.send({ type: 'mri-set-floating', enabled: true });
    await h.send({ type: 'mri-disable-floating' });
    check('content close setting persists and broadcasts', h.state().settings.floatingEnabled === false);
    await h.send({ type: 'mri-clear' });
    await h.send({ type: 'mri-record', record: record(3) });
    check('clear creates fresh model counts without shared defaults', h.state().stats.modelCounts['gpt-6'] === 1);
  }
  {
    const h = harness();
    h.fail('set');
    const failure = await h.send({ type: 'mri-record', record: record(1) });
    check('failed write acknowledged without false success', !failure.ok && failure.error === 'storage-unavailable' && !h.state().records);
    await h.send({ type: 'mri-record', record: record(2) });
    check('queue recovers after failed operation', h.state().records.length === 1 && h.state().stats.totalRequests === 1);
    h.fail('get');
    const getFailure = await h.send({ type: 'mri-get-data' });
    check('failed reads return bounded error', !getFailure.ok && getFailure.error === 'storage-unavailable');
    h.fail('set');
    const clearFailure = await h.send({ type: 'mri-clear' });
    check('failed clear preserves history', !clearFailure.ok && h.state().records.length === 1);
  }
  {
    const h = harness();
    await h.send({ type: 'mri-record', record: record(1, { status: 'mismatch', serverModel: 'gpt-5' }) });
    await h.send({ type: 'mri-record', record: record(2, { status: 'mismatch', serverModel: 'gpt-5' }) });
    await h.send({ type: 'mri-record', record: record(3, { status: 'mismatch', serverModel: 'gpt-4' }) });
    check('notifications compare previous model before stats update', h.notifications.length === 2 && h.state().stats.mismatchCount === 3);
    await h.send({ type: 'mri-record', record: record(4, { status: 'unknown', requestedModel: 'gpt-3', resolvedModel: null, serverModel: null }) });
    await h.send({ type: 'mri-record', record: record(5, { status: 'mismatch', requestedModel: 'gpt-6', resolvedModel: 'gpt-3', serverModel: 'gpt-3' }) });
    check('requested-only previous round does not suppress actual model notification', h.notifications.length === 3);
  }
  {
    const h = harness();
    await h.send({ type: 'mri-record', record: record(1, {
      url: 'https://chatgpt.com/backend-api/f/conversation?token=synthetic#secret', endpoint: '/backend-api/f/conversation?token=synthetic',
      autoSwitcherRaceWinner: { content: 'synthetic body', token: 'synthetic' }, toolName: { value: 'synthetic' }, requestedExperience: ['synthetic'],
      fieldSources: { serverModel: 'metadata.model_slug', reason: { token: 'synthetic' }, token: 'synthetic' },
      fieldStates: { serverModel: 'value', region: 'null', toolName: 'invalid', token: 'value' },
      modelSwitcherDeny: ['gpt-5', { body: 'synthetic' }], completionSignals: ['[DONE]', 'message_stream_complete', 'arbitrary'],
      firstTextMs: 0, streamComplete: true, transportCanceled: true, completionMs: 90, timingSource: 'performance.now',
      body: 'synthetic body', headers: { token: 'synthetic' }
    }) });
    const saved = h.state().records[0];
    check('sanitizer strips URL query/hash and non-routing paths', saved.url === 'https://chatgpt.com/backend-api/f/conversation' && saved.endpoint === '/backend-api/f/conversation');
    check('nested objects/unknown keys never pass persistence boundary', !('autoSwitcherRaceWinner' in saved) && !('toolName' in saved) && !('body' in saved) && !('headers' in saved) && !('reason' in saved.fieldSources) && !('token' in saved.fieldStates) && saved.modelSwitcherDeny.length === 1);
    check('new completion/timing/state contract survives persistence', saved.firstTextMs === 0 && saved.streamComplete && saved.transportCanceled && saved.completionMs === 90 && saved.fieldStates.region === 'null' && saved.fieldStates.toolName === 'invalid' && saved.completionSignals.length === 2);
    const invalid = await h.send({ type: 'mri-record', record: record(2, { endpoint: 'https://untrusted.example/api' }) });
    check('invalid records do not count', !invalid.ok && invalid.error === 'invalid-record' && h.state().records.length === 1);
    const versioned = await h.send({ type: 'mri-record', record: record(4, { endpoint: '/backend-api/v2/conversation', url: 'https://chatgpt.com/backend-api/v2/conversation?token=synthetic' }) });
    check('versioned routing endpoint accepted without query', versioned.ok && h.state().records.at(-1).endpoint === '/backend-api/v2/conversation');
    await h.send({ type: 'mri-record', record: record(3, { serverModel: '__proto__' }) });
    check('prototype-like model names counted safely', h.state().stats.modelCounts.__proto__ === 1);
  }
  {
    const h = harness();
    const foreign = await h.send({ type: 'mri-clear' }, { id: 'foreign', url: 'chrome-extension://synthetic-extension/src/popup.html' });
    const page = await h.raw({ type: 'mri-clear' });
    check('reject unrelated extension and chat-content management commands', foreign.error === 'unauthorized-sender' && page.error === 'unauthorized-sender');
    const popupTab = await h.send({ type: 'mri-get-data' }, { id: 'synthetic-extension', url: 'chrome-extension://synthetic-extension/src/popup.html', tab: { id: 2 } });
    check('trusted popup HTML works both as action popup and browser tab', popupTab.ok && Array.isArray(popupTab.records));
    const invalidSetting = await h.send({ type: 'mri-set-floating', enabled: 'false' });
    check('setting rejects truthy string coercion', invalidSetting.error === 'invalid-setting');
  }
  {
    const h = harness();
    await h.send({ type: 'mri-record', record: record(1, { serverModel: '=1+1', reason: '+formula', startedAt: 1e100, endedAt: 1e100 }) });
    const csv = await h.send({ type: 'mri-export-csv' });
    const json = await h.send({ type: 'mri-export-json' });
    check('CSV formula prefixes escaped and invalid timestamp safe', csv.ok && csv.csv.includes("'=1+1") && csv.csv.includes("'+formula"));
    check('JSON and CSV share persisted snapshot', JSON.parse(json.json).records.length === 1 && csv.csv.split('\r\n').length === 2);
  }
  {
    const h = harness({ records: Array.from({ length: 1000 }, (_, index) => record(index)), stats: { totalRequests: 1000, matchCount: 1000, modelCounts: { 'gpt-6': 1000 } } });
    await h.send({ type: 'mri-record', record: record(1000) });
    check('retention trims history but cumulative stats preserved', h.state().records.length === 1000 && h.state().records[0].requestId === 'synthetic-1' && h.state().stats.totalRequests === 1001);
    const restart = harness(h.state());
    await restart.send({ type: 'mri-record', record: record(1001) });
    check('worker restart resumes durable counts/history', restart.state().records.length === 1000 && restart.state().stats.totalRequests === 1002);
  }
  {
    const h = harness({ records: [record(1, { url: 'https://chatgpt.com/backend-api/f/conversation?token=synthetic', autoSwitcherRaceWinner: { body: 'synthetic' } })], stats: { totalRequests: 1 }, settings: { floatingEnabled: false } });
    h.installed();
    await h.send({ type: 'mri-get-data' });
    check('install/update migrates old stored metadata through sanitizer', h.state().records.length === 1 && !('autoSwitcherRaceWinner' in h.state().records[0]) && !h.state().records[0].url.includes('?') && h.state().settings.floatingEnabled === false);
  }
  console.log('\nStorage regressions: ' + passed + ' passed. Mocked API proof; not browser multitab acceptance.');
})().catch(error => { console.error(error); process.exitCode = 1; });

/* popup.js — 插件弹窗逻辑（记录 + 诊断两个标签页） */
(function () {
  'use strict';

  const STATUS_LABEL = {
    match: '一致',
    mismatch: '切换',
    unknown: '待确认',
    conflict: '冲突'
  };

  function send(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (res) {
        void chrome.runtime.lastError;
        resolve(res);
      });
    });
  }

  function sendToTab(tabId, msg) {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tabId, msg, function (res) {
        void chrome.runtime.lastError;
        resolve(res);
      });
    });
  }

  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function shortModel(s) { return s ? String(s).replace(/^gpt-/i, '') : '—'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  function val(v) {
    if (v === null || v === undefined || v === '') return '<span style="opacity:0.35">—</span>';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return v.length ? esc(JSON.stringify(v)) : '[]';
    if (typeof v === 'object') return esc(JSON.stringify(v));
    return esc(v);
  }

  function row(label, value, mono) {
    return '<div class="k">' + label + '</div><div class="v' + (mono ? ' mono' : '') + '">' + val(value) + '</div>';
  }

  function group(title, rows) {
    if (!rows) return '';
    return '<div class="group-title">' + title + '</div><div class="kv">' + rows + '</div>';
  }

  /* ---------------- 记录页 ---------------- */

  function renderStats(stats) {
    const total = stats.totalRequests || 0;
    const mismatch = stats.mismatchCount || 0;
    const ratio = total ? Math.round((mismatch / total) * 100) : 0;
    const counts = stats.modelCounts || {};
    const modelEntries = Object.keys(counts)
      .map(function (k) { return [k, counts[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 6)
      .map(function (e) { return shortModel(e[0]) + ' ' + e[1]; })
      .join('  ·  ');

    document.getElementById('stats').innerHTML =
      '<div class="stat"><div class="num">' + total + '</div><div class="lbl">总请求</div></div>' +
      '<div class="stat match"><div class="num">' + (stats.matchCount || 0) + '</div><div class="lbl">一致</div></div>' +
      '<div class="stat mismatch"><div class="num">' + mismatch + '</div><div class="lbl">切换 ' + ratio + '%</div></div>' +
      '<div class="stat unknown"><div class="num">' + ((stats.unknownCount || 0) + (stats.conflictCount || 0)) + '</div><div class="lbl">待确认/冲突</div></div>' +
      (modelEntries ? '<div class="models-breakdown"><div class="mb-title">模型出现次数</div><div>' + modelEntries + '</div></div>' : '');
  }

  function buildDetail(r) {
    return group('模型路由',
      row('Requested', r.requestedModel, true) +
      row('Resolved', r.resolvedModel, true) +
      row('Server', r.serverModel, true) +
      row('Default', r.defaultModel, true) +
      row('Message model', r.messageModel, true)
    ) + group('模式',
      row('Experience', r.requestedExperience) +
      row('Product', r.productExperience) +
      row('Turn mode', r.turnMode) +
      row('Use case', r.turnUseCase) +
      row('Thinking effort', r.thinkingEffort)
    ) + group('自动切换器',
      row('Autoswitcher enabled', r.isAutoswitcherEnabled) +
      row('Auto switched→reasoning', r.didAutoSwitchToReasoning) +
      row('Switcher winner', r.autoSwitcherRaceWinner) +
      row('Switcher deny', r.modelSwitcherDeny)
    ) + group('服务端调度',
      row('Fast convo', r.fastConvo) +
      row('Warmup state', r.warmupState) +
      row('Conduit prewarmed', r.conduitPrewarmed) +
      row('First turn', r.isFirstTurn)
    ) + group('账户',
      row('Plan', r.planType) +
      row('Plan bucket', r.planTypeBucket)
    ) + group('传输',
      row('Transport', r.transport) +
      row('Endpoint', r.endpoint, true) +
      row('HTTP', r.responseStatus) +
      row('Content-Type', r.contentType, true) +
      row('Resume via WS', r.resumeWithWebsockets)
    ) + group('任务类型',
      row('Tool invoked', r.toolInvoked) +
      row('Tool name', r.toolName) +
      row('Is search', r.isSearch) +
      row('Search calls', r.searchToolCallCount) +
      row('Search types', r.searchToolQueryTypes) +
      row('Is multimodal', r.isMultimodal) +
      row('Prompt has image', r.didPromptContainImage)
    ) + group('基础设施',
      row('Cluster region', r.clusterRegion) +
      row('Region', r.region) +
      row('Server TTFVT (ms)', r.serverTtfvt)
    ) + group('性能',
      row('First byte (ms)', r.firstByteMs) +
      row('First delta (ms)', r.firstDeltaMs) +
      row('Total (ms)', r.totalMs) +
      row('Reasoning start', r.reasoningStartTime) +
      row('Reasoning end', r.reasoningEndTime) +
      row('Reasoning (ms)', r.reasoningDurationMs) +
      row('Finished (s)', r.finishedDurationSec)
    ) + group('追踪',
      row('Conversation', r.conversationId, true) +
      row('Message', r.messageId, true) +
      row('Server request', r.serverRequestId, true) +
      row('Turn exchange', r.turnExchangeId, true) +
      row('Turn trace', r.turnTraceId, true) +
      row('检测时间', fmtDateTime(r.timestamp || r.endedAt))
    ) +
    '<div class="reason">判定依据：' + esc(r.reason || r.status) + '</div>';
  }

  function renderList(records) {
    const list = document.getElementById('list');
    list.innerHTML = '';
    if (!records.length) {
      list.innerHTML = '<div class="empty">还没有捕获到 conversation 请求。<br/>打开 ChatGPT 发送一条消息试试。<br/>如果仍然空白，请查看「诊断」标签页。</div>';
      return;
    }
    const tpl = document.getElementById('tpl-item');
    const sorted = records.slice().sort(function (a, b) {
      return (b.timestamp || b.endedAt || 0) - (a.timestamp || a.endedAt || 0);
    });
    sorted.forEach(function (r) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector('.dot').classList.add(r.status);
      node.querySelector('.time').textContent = fmtTime(r.timestamp || r.endedAt);
      const actual = r.serverModel || r.resolvedModel || r.messageModel;
      const modelsEl = node.querySelector('.models');
      if (r.status === 'mismatch' && r.requestedModel && actual && r.requestedModel !== actual) {
        modelsEl.innerHTML = '<span class="req">' + esc(shortModel(r.requestedModel)) + '</span>' +
          '<span class="arrow">→</span><span class="act">' + esc(shortModel(actual)) + '</span>';
      } else {
        modelsEl.innerHTML = '<span class="act">' + esc(shortModel(actual || r.requestedModel || r.modelSlug || '—')) + '</span>';
      }
      const statusEl = node.querySelector('.status');
      statusEl.classList.add(r.status);
      statusEl.textContent = STATUS_LABEL[r.status] || r.status;
      node.querySelector('.detail').innerHTML = buildDetail(r);
      node.querySelector('.item-row').addEventListener('click', function () {
        node.classList.toggle('open');
      });
      list.appendChild(node);
    });
  }

  /* ---------------- 诊断页 ---------------- */

  function diagLine(label, value, ok) {
    const cls = ok === true ? 'diag-ok' : ok === false ? 'diag-bad' : '';
    return '<div class="diag-row"><span class="k">' + esc(label) + '</span>' +
      '<span class="v ' + cls + '">' + (value instanceof Object ? esc(JSON.stringify(value)) : esc(value)) + '</span></div>';
  }

  function renderDiag(res) {
    const body = document.getElementById('diag-body');
    const pageEl = document.getElementById('diag-page');
    if (!res || !res.ok || !res.diag) {
      pageEl.textContent = '';
      body.innerHTML = '<div class="diag-empty">无法连接到 ChatGPT 页面的注入脚本。<br/>请确认已打开 chatgpt.com 并刷新页面。<br/>错误：' +
        esc((res && res.error) || 'no response') + '</div>';
      return;
    }
    const d = res.diag;
    const L = d.last || {};
    pageEl.textContent = d.href || '';

    const checks = [
      ['MAIN world injection', d.hookInstalled ? '✅ 已注入' : '❌ 未注入', d.hookInstalled],
      ['fetch hook installed', d.hookInstalled ? '✅' : '❌', d.hookInstalled],
      ['fetch calls observed', d.fetchCalls, null],
      ['conversation candidates', d.candidates, null],
      ['matched generation stream', d.matched, d.matched > 0],
      ['records produced', d.records, d.records > 0]
    ];
    let html = '<div class="diag-section"><h4>状态</h4>';
    checks.forEach(function (c) { html += diagLine(c[0], c[1], c[2]); });
    html += '</div>';

    html += '<div class="diag-section"><h4>最近一次候选请求</h4>';
    html += diagLine('URL', L.url || '—');
    html += diagLine('Endpoint', L.endpoint || '—');
    html += diagLine('Method', L.method || '—');
    html += diagLine('HTTP', L.status != null ? L.status : '—', L.status === 200 ? true : (L.status ? false : null));
    html += diagLine('Content-Type', L.contentType || '—', L.contentType && L.contentType.indexOf('event-stream') !== -1 ? true : null);
    html += diagLine('Transport', L.transport || '—');
    html += diagLine('Matched as generation', L.matched ? '✅ 是' : '❌ 否', L.matched);
    html += '</div>';

    html += '<div class="diag-section"><h4>SSE 解析</h4>';
    html += diagLine('SSE chunks', L.chunks, L.chunks > 0);
    html += diagLine('SSE events', L.events, L.events > 0);
    html += diagLine('JSON events', L.jsonEvents, L.jsonEvents > 0);
    html += diagLine('server_ste_metadata', L.hasServerSte ? '✅ found' : '❌ missing', L.hasServerSte);
    html += diagLine('resolved_model_slug', L.hasResolved ? '✅ found' : '❌ missing', L.hasResolved);
    html += diagLine('requested model (body)', L.hasRequested ? '✅ found' : '❌ missing', L.hasRequested);
    html += diagLine('Last parser error', L.parserError || 'none', !L.parserError);
    html += diagLine('Last error', L.error || 'none', !L.error);
    html += '</div>';

    html += '<div class="diag-section"><h4>最近判定</h4>';
    html += diagLine('Judgment', L.judgment || '—');
    html += diagLine('Requested', L.requestedModel || '—');
    html += diagLine('Resolved', L.resolvedModel || '—');
    html += diagLine('Server', L.serverModel || '—');
    html += '</div>';

    if (d.unknownMetaKeys && d.unknownMetaKeys.length) {
      html += '<div class="diag-section"><h4>未知 metadata key（仅记录名称，不存值）</h4>';
      html += '<div class="diag-row"><span class="v" style="grid-column:1/-1">' + esc(d.unknownMetaKeys.join(', ')) + '</span></div>';
      html += '</div>';
    }

    body.innerHTML = html;
  }

  async function refreshDiag() {
    document.getElementById('diag-body').innerHTML = '<div class="diag-empty">读取中…</div>';
    const tabs = await new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, resolve);
    });
    const tab = tabs && tabs[0];
    if (!tab || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
      renderDiag({ ok: false, error: '当前标签页不是 ChatGPT 页面' });
      return;
    }
    const res = await sendToTab(tab.id, { type: 'mri-get-diag' });
    renderDiag(res);
  }

  /* ---------------- 初始化 ---------------- */

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function refreshRecords() {
    const res = await send({ type: 'mri-get-data' });
    if (!res) return;
    renderStats(res.stats || {});
    renderList(res.records || []);
    const btn = document.getElementById('btn-floating');
    btn.textContent = '悬浮卡: ' + (res.settings && res.settings.floatingEnabled ? '开' : '关');
    btn.dataset.enabled = res.settings && res.settings.floatingEnabled ? '1' : '0';
  }

  document.addEventListener('DOMContentLoaded', function () {
    // tabs
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        const panel = document.getElementById('tab-' + t.dataset.tab);
        panel.classList.add('active');
        if (t.dataset.tab === 'diag') refreshDiag();
      });
    });

    refreshRecords();

    document.getElementById('btn-clear').addEventListener('click', async function () {
      if (!confirm('确定清空所有历史记录？')) return;
      await send({ type: 'mri-clear' });
      refreshRecords();
    });
    document.getElementById('btn-json').addEventListener('click', async function () {
      const res = await send({ type: 'mri-export-json' });
      if (res && res.json) download('mri-' + Date.now() + '.json', res.json, 'application/json');
    });
    document.getElementById('btn-csv').addEventListener('click', async function () {
      const res = await send({ type: 'mri-export-csv' });
      if (res && res.csv) download('mri-' + Date.now() + '.csv', res.csv, 'text/csv;charset=utf-8');
    });
    document.getElementById('btn-floating').addEventListener('click', async function () {
      const next = this.dataset.enabled !== '1';
      await send({ type: 'mri-set-floating', enabled: next });
      refreshRecords();
    });
    document.getElementById('btn-diag-refresh').addEventListener('click', refreshDiag);
  });
})();

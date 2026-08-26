/*
 * content.js — 运行在 ISOLATED world
 *  1. 接收 injected.js 通过 window.postMessage 发来的记录
 *  2. 转发给 background 存储 / 更新徽章
 *  3. 在页面右下角渲染一个极简悬浮状态卡
 */
(function () {
  'use strict';

  // content.js 运行在 ISOLATED world，访问不到 MAIN world 的 __MRI__，
  // 因此这里自带一份与 detector.js 一致的格式化函数。
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

  const STATE = {
    floatingEnabled: true,
    lastRecord: null,
    el: null,
    dotEl: null,
    nameEl: null,
    subEl: null,
    closeEl: null
  };

  const STATUS_COLORS = {
    match: '#22c55e',    // 绿色
    mismatch: '#ef4444', // 红色
    unknown: '#eab308',  // 黄色
    conflict: '#f97316'  // 橙色
  };

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, function () {
        // 读取 lastError 避免 "message port closed" 警告
        void chrome.runtime.lastError;
      });
    } catch (_) { /* ignore */ }
  }

  function buildWidget() {
    if (STATE.el) return;
    const root = document.createElement('div');
    root.id = 'mri-floating-root';
    root.setAttribute('data-mri', '1');
    // 容器不拦截鼠标；卡片本身可交互
    root.style.cssText = [
      'all: initial',
      'position: fixed',
      'right: 16px',
      'bottom: 16px',
      'z-index: 2147483647',
      'pointer-events: none',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'pointer-events: auto',
      'display: flex',
      'align-items: flex-start',
      'gap: 8px',
      'max-width: 260px',
      'padding: ' + '8px 10px',
      'border-radius: 10px',
      'background: rgba(15, 15, 15, 0.82)',
      'color: #f5f5f5',
      'font-size: 12px',
      'line-height: 1.35',
      'box-shadow: 0 4px 16px rgba(0,0,0,0.28)',
      'backdrop-filter: blur(6px)',
      'border: 1px solid rgba(255,255,255,0.08)'
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText = [
      'flex: 0 0 auto',
      'width: 9px',
      'height: 9px',
      'margin-top: 4px',
      'border-radius: 50%',
      'background: #888',
      'box-shadow: 0 0 6px currentColor'
    ].join(';');

    const textWrap = document.createElement('div');
    textWrap.style.cssText = 'flex: 1 1 auto; min-width: 0;';

    const name = document.createElement('div');
    name.style.cssText = 'font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

    const sub = document.createElement('div');
    sub.style.cssText = 'opacity: 0.75; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

    const close = document.createElement('button');
    close.textContent = '\u00D7';
    close.title = '隐藏悬浮卡（可在插件弹窗中重新开启）';
    close.style.cssText = [
      'flex: 0 0 auto',
      'appearance: none',
      'border: 0',
      'background: transparent',
      'color: rgba(255,255,255,0.6)',
      'font-size: 16px',
      'line-height: 1',
      'cursor: pointer',
      'padding: 0 2px'
    ].join(';');
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      send({ type: 'mri-disable-floating' });
    });

    textWrap.appendChild(name);
    textWrap.appendChild(sub);
    card.appendChild(dot);
    card.appendChild(textWrap);
    card.appendChild(close);
    root.appendChild(card);

    STATE.el = root;
    STATE.dotEl = dot;
    STATE.nameEl = name;
    STATE.subEl = sub;
    STATE.closeEl = close;
  }

  function ensureAttached() {
    buildWidget();
    if (STATE.el && !STATE.el.parentNode) {
      (document.body || document.documentElement).appendChild(STATE.el);
    }
  }

  function hideWidget() {
    if (STATE.el && STATE.el.parentNode) STATE.el.parentNode.removeChild(STATE.el);
  }

  function render(rec) {
    STATE.lastRecord = rec;
    if (!STATE.floatingEnabled) { hideWidget(); return; }
    ensureAttached();

    const color = STATUS_COLORS[rec.status] || '#888';
    STATE.dotEl.style.background = color;
    STATE.dotEl.style.color = color;

    const actual = rec.serverModel || rec.resolvedModel || rec.requestedModel || rec.modelSlug;
    STATE.nameEl.textContent = prettyModel(actual);

    let sub = '';
    if (rec.thinkingEffort) {
      sub += String(rec.thinkingEffort);
    }
    if (rec.status === 'mismatch' && rec.requestedModel && actual && rec.requestedModel !== actual) {
      sub += (sub ? ' · ' : '') + 'from ' + prettyModel(rec.requestedModel);
    } else if (rec.status === 'conflict') {
      sub += (sub ? ' · ' : '') + 'metadata conflict';
    } else if (rec.status === 'unknown') {
      sub += (sub ? ' · ' : '') + 'unconfirmed';
    }
    const region = rec.clusterRegion || rec.region;
    if (region) sub += (sub ? ' · ' : '') + region;
    if (rec.fastConvo === true) sub += (sub ? ' · ' : '') + 'fast';
    STATE.subEl.textContent = sub;
  }

  // 接收来自 injected.js 的消息
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'mri') return;

    if (msg.type === 'record' && msg.record) {
      // 只转发可序列化的路由元数据，绝不转发正文（injected 本身也不采集正文）
      send({ type: 'mri-record', record: msg.record });
      render(msg.record);
    } else if (msg.type === 'request-start') {
      // 可用于未来显示“检测中”状态，v1 暂不处理
    }
  });

  // 接收来自 background 的设置变更
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'mri-content') return;
    if (msg.type === 'mri-floating-setting') {
      STATE.floatingEnabled = !!msg.enabled;
      if (STATE.floatingEnabled && STATE.lastRecord) render(STATE.lastRecord);
      else hideWidget();
    } else if (msg.type === 'mri-floating-refresh' && STATE.lastRecord) {
      render(STATE.lastRecord);
    }
  });

  // 诊断查询：popup → content → (postMessage) → injected → 回传
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'mri-get-diag') return;
    let settled = false;
    function onReply(ev) {
      if (ev.source !== window) return;
      const m = ev.data;
      if (!m || m.source !== 'mri' || m.type !== 'diag') return;
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onReply);
      sendResponse({ ok: true, diag: m.diag });
    }
    window.addEventListener('message', onReply);
    window.postMessage({ source: 'mri', type: 'diag-request' }, '*');
    // 超时兜底
    setTimeout(function () {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onReply);
      sendResponse({ ok: false, error: 'injected script did not respond (not injected?)' });
    }, 600);
    return true; // 异步响应
  });

  // 初始查询悬浮卡开关 + 最近一条记录
  send({ type: 'mri-content-ready' });
})();

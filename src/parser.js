/*
 * parser.js — 健壮的 SSE (Server-Sent Events) 增量解析器
 *
 * 设计目标：
 *  - 一个 JSON 被拆在多个 chunk 里也能正确重组
 *  - 一个 chunk 包含多条 SSE 事件
 *  - "event:" 与 "data:" 分行出现
 *  - 以空行作为事件边界（兼容 \n 与 \r\n）
 *  - 非 JSON 数据 / [DONE] / malformed event 不抛异常
 *  - 解析失败绝不影响调用方（ChatGPT 本身）
 *
 * 用法：
 *   const p = createParser(onEvent);
 *   p.feed(chunkString1);
 *   p.feed(chunkString2);
 *   p.end();
 *   // onEvent({ event, data, done?, parseError? })
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.__MRI__ = Object.assign(root.__MRI__ || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createParser(onEvent) {
    let buffer = '';
    let eventType = '';
    let dataLines = [];

    function dispatch() {
      // 空事件（只有 event 没有 data）忽略
      if (dataLines.length === 0) {
        eventType = '';
        return;
      }
      const data = dataLines.join('\n');
      const type = eventType || 'message';
      eventType = '';
      dataLines = [];

      if (data === '[DONE]') {
        onEvent({ event: type, data: '[DONE]', done: true });
        return;
      }
      try {
        const json = JSON.parse(data);
        onEvent({ event: type, data: json });
      } catch (e) {
        // 非 JSON / malformed —— 不抛出，交给调用方决定是否忽略
        onEvent({ event: type, data: data, parseError: true, error: String(e && e.message || e) });
      }
    }

    function feed(chunk) {
      if (chunk == null) return;
      buffer += String(chunk);

      let pos = 0;
      while (pos < buffer.length) {
        const nl = buffer.indexOf('\n', pos);
        if (nl === -1) break; // 等待下一个 chunk 补全
        let line = buffer.slice(pos, nl);
        pos = nl + 1;
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          dispatch(); // 空行 = 事件边界
        } else if (line.charAt(0) === ':') {
          // SSE 注释，忽略
        } else {
          const colon = line.indexOf(':');
          let field, value;
          if (colon === -1) {
            field = line;
            value = '';
          } else {
            field = line.slice(0, colon);
            value = line.slice(colon + 1);
            if (value.charAt(0) === ' ') value = value.slice(1);
          }
          if (field === 'event') {
            eventType = value;
          } else if (field === 'data') {
            dataLines.push(value);
          }
          // id / retry 等字段与本扩展无关，忽略
        }
      }
      buffer = buffer.slice(pos);
    }

    function end() {
      // 某些服务端在最后一条事件后不发空行，做一次兜底派发
      if (dataLines.length > 0) dispatch();
      buffer = '';
    }

    return { feed: feed, end: end };
  }

  return { createParser: createParser };
});

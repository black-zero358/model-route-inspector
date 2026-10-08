/* Bounded incremental SSE parser. Never retains malformed payloads or callback errors. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.__MRI__ = Object.assign(root.__MRI__ || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createParser(onEvent, options) {
    const maxChars = options && options.maxEventChars || 1024 * 1024;
    let fragments = [], lineSize = 0, dataLines = [], eventSize = 0;
    let eventType = '', dropping = false, pendingCR = false, first = true, closed = false;
    let discardedLine = false;

    function emit(event) {
      try { onEvent(event); } catch (_) { /* isolate consumers */ }
    }
    function reset() {
      dataLines = []; eventSize = 0; eventType = ''; dropping = false;
    }
    function overflow() {
      if (!dropping) emit({ event: 'message', parseError: true, limitExceeded: true, error: 'SSE event exceeds capture limit' });
      dropping = true; fragments = []; dataLines = []; lineSize = 0; discardedLine = true;
    }
    function dispatch(unterminated) {
      if (dropping || !dataLines.length) { reset(); return; }
      const data = dataLines.join('\n'), event = eventType || 'message';
      reset();
      if (data === '[DONE]') { emit({ event: event, data: '[DONE]', done: true, unterminated: !!unterminated }); return; }
      let value;
      try { value = JSON.parse(data); }
      catch (_) { emit({ event: event, parseError: true, error: 'Invalid SSE JSON' }); return; }
      emit({ event: event, data: value, unterminated: !!unterminated });
    }
    function line(value) {
      if (!value) { dispatch(false); return; }
      if (dropping || value[0] === ':') return;
      const colon = value.indexOf(':');
      const field = colon < 0 ? value : value.slice(0, colon);
      let text = colon < 0 ? '' : value.slice(colon + 1);
      if (text[0] === ' ') text = text.slice(1);
      if (field === 'event') eventType = text.slice(0, 128);
      if (field === 'data') {
        eventSize += text.length + 1;
        if (eventSize > maxChars) overflow();
        else dataLines.push(text);
      }
    }
    function append(text) {
      if (!text) return;
      if (dropping) { discardedLine = true; return; }
      lineSize += text.length;
      if (lineSize + eventSize > maxChars) overflow();
      else {
        fragments.push(text);
        if (fragments.length > 4096) fragments = [fragments.join('')];
      }
    }
    function finishLine() {
      const text = fragments.join('');
      fragments = []; lineSize = 0;
      // A discarded overlong line must not be mistaken for an empty event separator.
      if (dropping && discardedLine) { discardedLine = false; return; }
      line(text);
      if (dropping) discardedLine = false;
    }
    function feed(chunk) {
      if (closed || chunk == null) return;
      let text = String(chunk);
      if (!text) return;
      if (first) { first = false; if (text[0] === '\uFEFF') text = text.slice(1); }
      let start = 0;
      if (pendingCR) { if (text[0] === '\n') start = 1; pendingCR = false; }
      const newline = /[\r\n]/g;
      newline.lastIndex = start;
      let match;
      while ((match = newline.exec(text))) {
        append(text.slice(start, match.index));
        finishLine();
        start = match.index + 1;
        if (match[0] === '\r') {
          if (text[start] === '\n') { start++; newline.lastIndex = start; }
          else if (start === text.length) pendingCR = true;
        }
      }
      append(text.slice(start));
    }
    function end() {
      if (closed) return;
      // Inspector compatibility recovery; unlike EventSource, recover the tail but flag it.
      if (fragments.length) finishLine();
      dispatch(true);
      fragments = []; closed = true;
    }
    function dispose() { fragments = []; reset(); closed = true; }
    return { feed: feed, end: end, dispose: dispose };
  }
  return { createParser: createParser };
});

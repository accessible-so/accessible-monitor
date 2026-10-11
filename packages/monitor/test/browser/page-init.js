/*
 * Injected into every fixture page at document start, before any page script
 * runs. Two watchers:
 *
 * 1. `window.__mutations` — every mutation of the host DOM. The observer is
 *    attached to `document` rather than `document.documentElement`, because at
 *    document start the documentElement does not exist yet; observing the
 *    document with `subtree: true` is a superset and misses nothing. Each
 *    record carries the time it was delivered and the readyState it was
 *    delivered in. `window.__dclAt` marks DOMContentLoaded, and the parser's
 *    own insertions are all delivered before it — so the constraint suite
 *    filters on `t > __dclAt` and holds the collector to the one mutation it
 *    is allowed: inserting the engine <script> into <head>. (readyState alone
 *    is not enough: a mutation record queued during parsing is delivered at
 *    the next microtask checkpoint, by which time readyState has already
 *    flipped to "interactive".)
 *
 * 2. `window.__longTasks` — long tasks, for the performance budget suite.
 */
(function () {
  'use strict';
  window.__mutations = [];
  window.__longTasks = [];
  window.__dclAt = Infinity;
  document.addEventListener('DOMContentLoaded', function () { window.__dclAt = performance.now(); }, true);

  function tags(nodes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      out.push(n.nodeType === 1 ? n.tagName.toLowerCase() : '#' + n.nodeName.toLowerCase());
    }
    return out;
  }

  try {
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var target = r.target;
        window.__mutations.push({
          t: performance.now(),
          phase: document.readyState,
          type: r.type,
          target: target.nodeType === 1 ? target.tagName.toLowerCase() : '#' + target.nodeName.toLowerCase(),
          attr: r.attributeName || null,
          added: tags(r.addedNodes),
          removed: tags(r.removedNodes),
        });
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  } catch (e) {
    window.__mutationObserverError = String(e);
  }

  try {
    var perf = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        window.__longTasks.push({ startTime: entries[i].startTime, duration: entries[i].duration });
      }
    });
    perf.observe({ entryTypes: ['longtask'] });
  } catch (e) {
    window.__longTaskObserverError = String(e);
  }
})();

/*
 * Fixture behaviour. No frameworks, no build step. Three deliberate
 * anti-patterns the collector's behavioural observers are supposed to notice:
 * a client-side route swap that strands focus, a dialog whose Tab loop has no
 * exit and ignores Escape, and an element that swallows Tab entirely.
 */
(function () {
  'use strict';
  var d = document;

  /* 1. SPA route swap. pushState, replace <main>, never move focus. The link
   *    lives inside <main>, so replacing it drops focus to <body> — which is
   *    exactly how real frameworks lose it. */
  var go = d.getElementById('go-products');
  if (go) {
    go.addEventListener('click', function (e) {
      e.preventDefault();
      history.pushState({}, '', '/products');
      var main = d.querySelector('main');
      if (!main) return;
      main.innerHTML =
        '<h1>All products</h1>' +
        '<p>Swapped in place. Nothing called focus().</p>' +
        '<ul class="grid"><li class="card" data-a11y-component="ProductCard">' +
        '<a class="thumb" href="https://example.com/p/99?utm_campaign=spa"><img src="/img/secret.png"></a>' +
        '<h3>Widget 99</h3>' +
        '<p><a class="more" href="/products.html?utm_source=spa">click here</a></p>' +
        '<button class="icon" type="button"><span aria-hidden="true">★</span></button>' +
        '</li></ul>';
    });
  }

  /* 2. Dialog with a closed Tab loop and no Escape handler. */
  var dialog = d.getElementById('dialog');
  var open = d.getElementById('open-dialog');
  var opts = dialog ? Array.prototype.slice.call(dialog.querySelectorAll('.opt')) : [];
  if (open && dialog) {
    open.addEventListener('click', function () {
      dialog.hidden = false;
      if (opts[0]) opts[0].focus();
    });
  }
  if (dialog) {
    dialog.addEventListener('keydown', function (e) {
      /* Escape is deliberately unhandled: there is no way out. */
      if (e.key !== 'Tab') return;
      e.preventDefault();
      var i = opts.indexOf(d.activeElement);
      var next = e.shiftKey ? (i - 1 + opts.length) % opts.length : (i + 1) % opts.length;
      if (opts[next]) opts[next].focus();
    });
  }

  /* 3. Dead end: Tab is cancelled, so focus never leaves. */
  var dead = d.getElementById('dead');
  if (dead) {
    dead.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') e.preventDefault();
    });
  }
})();

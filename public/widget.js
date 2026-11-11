/* Postbox web widget loader. Works as a classic or a module script:
   <script src="https://<your-postbox>/widget.js" data-key="pbk_..." async></script>
   Calls to Postbox.open() before the widget has loaded are queued. */
(() => {
  if (window.Postbox) return;
  const me = document.currentScript || document.querySelector('script[src*="/widget.js"][data-key]');
  if (!me || !me.dataset.key) return console.warn("Postbox: add data-key to the widget script tag.");
  const queue = [];
  window.Postbox = { open: (kind) => { queue.push(["open", kind]); }, setScreen: (name) => { queue.push(["setScreen", name]); } };
  import(new URL("widget/app.js", me.src).href)
    .then((m) => m.start(me, queue))
    .catch((e) => console.warn("Postbox: the widget could not load.", e));
})();

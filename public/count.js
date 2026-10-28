/*
 * Comment counts for index pages. Usage:
 *   <a href="/my-post/#comments" data-comment-count>Comments</a>
 *   <span data-comment-count="https://you.github.io/other-post/"></span>
 *   <script src="https://YOUR-WORKER/count.js" async></script>
 *
 * Each element's page is its data-comment-count value, else its href, else the current page.
 * Optional text templates on the script tag ({n} is replaced with the number):
 *   data-zero="No comments"  data-one="1 comment"  data-many="{n} comments"
 */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="count.js"]');
  if (!script) return;
  var API = new URL(script.src).origin;
  var ds = script.dataset;
  var tpl = {
    zero: ds.zero || "No comments",
    one: ds.one || "1 comment",
    many: ds.many || "{n} comments",
  };

  function label(n) {
    var t = n === 0 ? tpl.zero : n === 1 ? tpl.one : tpl.many;
    return t.replace("{n}", n);
  }

  function run() {
    var els = [].slice.call(document.querySelectorAll("[data-comment-count]"));
    var byUrl = {};
    els.forEach(function (el) {
      var raw = el.getAttribute("data-comment-count") || el.getAttribute("href") || location.href;
      var url;
      try {
        url = new URL(raw, location.href).href;
      } catch (e) {
        return;
      }
      (byUrl[url] = byUrl[url] || []).push(el);
    });

    var urls = Object.keys(byUrl);
    // The API takes up to 100 URLs per request.
    for (var i = 0; i < urls.length; i += 100) {
      var batch = urls.slice(i, i + 100);
      var qs = batch.map(function (u) { return "url=" + encodeURIComponent(u); }).join("&");
      fetch(API + "/api/counts?" + qs)
        .then(function (res) { return res.ok ? res.json() : { counts: {} }; })
        .then(function (data) {
          Object.keys(data.counts).forEach(function (u) {
            (byUrl[u] || []).forEach(function (el) {
              el.textContent = label(data.counts[u]);
            });
          });
        })
        .catch(function () {});
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();

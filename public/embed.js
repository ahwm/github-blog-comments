/*
 * Comment embed. Usage:
 *   <div id="comments"></div>
 *   <script src="https://YOUR-WORKER/embed.js" async></script>
 *
 * Optional attributes on the script tag:
 *   data-container  id of the element to render into (default "comments")
 *   data-url        page URL to thread on (default: canonical link, else location)
 *   data-theme      "light", "dark" or "auto" (default "auto")
 */
(function () {
  "use strict";

  var script = document.currentScript || document.querySelector('script[src*="embed.js"]');
  if (!script) return;
  var API = new URL(script.src).origin;
  var ds = script.dataset;
  var canonical = document.querySelector('link[rel="canonical"]');
  var PAGE_URL = ds.url || (canonical && canonical.href) || location.href;
  var THEME = ds.theme || "auto";
  var STORE = "sc:";

  var root = document.getElementById(ds.container || "comments");
  if (!root) {
    root = document.createElement("div");
    script.parentNode.insertBefore(root, script.nextSibling);
  }

  // ---------- Small helpers ----------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function load(key, fallback) {
    try {
      var v = localStorage.getItem(STORE + key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(STORE + key, JSON.stringify(value));
    } catch (e) {}
  }

  function api(path, opts) {
    return fetch(API + path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Request failed");
        return data;
      });
    });
  }

  var rtf = window.Intl && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
  function timeAgo(iso) {
    var secs = (new Date(iso).getTime() - Date.now()) / 1000;
    var units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    if (!rtf) return new Date(iso).toLocaleString();
    for (var i = 0; i < units.length; i++) {
      if (Math.abs(secs) >= units[i][1]) return rtf.format(Math.round(secs / units[i][1]), units[i][0]);
    }
    return rtf.format(0, "second");
  }

  // Plain text in, safe DOM out: paragraphs, line breaks and autolinked URLs.
  function renderBody(text) {
    var wrap = el("div", { class: "sc-body" });
    text.split(/\n{2,}/).forEach(function (para) {
      var p = el("p");
      para.split("\n").forEach(function (line, i) {
        if (i) p.appendChild(el("br"));
        line.split(/(https?:\/\/[^\s<>"]+)/g).forEach(function (part, j) {
          if (j % 2) {
            var href = part.replace(/[.,;:!?)]+$/, "");
            var tail = part.slice(href.length);
            p.appendChild(el("a", { href: href, rel: "nofollow ugc noopener", target: "_blank", text: href }));
            if (tail) p.appendChild(document.createTextNode(tail));
          } else if (part) {
            p.appendChild(document.createTextNode(part));
          }
        });
      });
      wrap.appendChild(p);
    });
    return wrap;
  }

  // Small stroke icons, drawn in currentColor so they follow the button's text color.
  var ICONS = {
    reply: [["polyline", { points: "9 17 4 12 9 7" }], ["path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" }]],
    trash: [
      ["path", { d: "M3 6h18" }],
      ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
      ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
    ],
  };
  function icon(name) {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    var attrs = { viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "sc-icon" };
    for (var k in attrs) svg.setAttribute(k, attrs[k]);
    ICONS[name].forEach(function (part) {
      var node = document.createElementNS(NS, part[0]);
      for (var a in part[1]) node.setAttribute(a, part[1][a]);
      svg.appendChild(node);
    });
    return svg;
  }

  function avatar(c) {
    if (c.avatar) {
      return el("img", {
        class: "sc-avatar",
        src: "https://gravatar.com/avatar/" + c.avatar + "?s=80&d=identicon",
        alt: "",
        loading: "lazy",
      });
    }
    var initial = (c.name || "?").trim().charAt(0).toUpperCase() || "?";
    return el("span", { class: "sc-avatar sc-initial", "aria-hidden": "true", text: initial });
  }

  // ---------- Turnstile (only when the server has a site key) ----------

  var turnstile = { siteKey: null, widget: null, box: null, pending: null };

  function initTurnstile(siteKey) {
    turnstile.siteKey = siteKey;
    turnstile.box = el("div", { class: "sc-turnstile" });
    root.appendChild(turnstile.box);
    window.__scTurnstileReady = function () {
      turnstile.widget = window.turnstile.render(turnstile.box, {
        sitekey: siteKey,
        execution: "execute",
        appearance: "interaction-only",
        callback: function (token) {
          if (turnstile.pending) turnstile.pending.resolve(token);
          turnstile.pending = null;
        },
        "error-callback": function () {
          if (turnstile.pending) turnstile.pending.reject(new Error("Verification failed. Please try again."));
          turnstile.pending = null;
        },
      });
    };
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__scTurnstileReady";
    s.async = true;
    document.head.appendChild(s);
  }

  function getTurnstileToken() {
    if (!turnstile.siteKey) return Promise.resolve(null);
    if (!turnstile.widget) return Promise.reject(new Error("Verification is still loading. Try again in a moment."));
    return new Promise(function (resolve, reject) {
      turnstile.pending = { resolve: resolve, reject: reject };
      window.turnstile.reset(turnstile.widget);
      window.turnstile.execute(turnstile.widget);
    });
  }

  // ---------- State and rendering ----------

  var state = { comments: [], replyTo: null };
  var mine = load("mine", {}); // id -> { token, page, comment?, pending? }
  var listEl, countEl, formEl;

  function myPendingForPage(page) {
    return Object.keys(mine)
      .map(function (id) { return mine[id]; })
      .filter(function (m) { return m.pending && m.page === page && m.comment; })
      .map(function (m) { return Object.assign({}, m.comment, { _pending: true }); });
  }

  function renderList() {
    var all = state.comments.slice();
    var ids = {};
    all.forEach(function (c) { ids[c.id] = true; });
    // Show the visitor their own held comments. Drop the local copy once approved.
    myPendingForPage(state.page).forEach(function (c) {
      if (ids[c.id]) {
        mine[c.id].pending = false;
        save("mine", mine);
      } else {
        all.push(c);
      }
    });

    var children = {};
    all.forEach(function (c) {
      var p = c.parentId && (ids[c.parentId] || all.some(function (x) { return x.id === c.parentId; })) ? c.parentId : "";
      (children[p] = children[p] || []).push(c);
    });
    Object.keys(children).forEach(function (k) {
      children[k].sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
    });

    var live = state.comments.filter(function (c) { return !c.deleted; }).length;
    countEl.textContent = live === 1 ? "1 comment" : live + " comments";

    listEl.textContent = "";
    if (!all.length) listEl.appendChild(el("p", { class: "sc-empty", text: "No comments yet. Start the conversation." }));

    function build(parent, depth, container) {
      (children[parent] || []).forEach(function (c) {
        var node = renderComment(c, depth);
        container.appendChild(node);
        if (state.replyTo === c.id) node.querySelector(".sc-main").appendChild(formEl);
        if (children[c.id]) {
          var kids = el("div", { class: depth < 4 ? "sc-children" : "sc-children sc-flat" });
          node.appendChild(kids);
          build(c.id, depth + 1, kids);
        }
      });
    }
    build("", 0, listEl);
  }

  function renderComment(c, depth) {
    if (c.deleted) {
      return el("article", { class: "sc-comment sc-deleted", id: "comment-" + c.id }, [
        el("div", { class: "sc-main" }, [el("p", { class: "sc-meta", text: "This comment was deleted." })]),
      ]);
    }
    var actions = el("div", { class: "sc-actions" });
    if (!c._pending) {
      actions.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "sc-action",
            "aria-label": "Reply to " + c.name,
            onclick: function () { state.replyTo = c.id; renderList(); focusForm(); },
          },
          [icon("reply"), "Reply"]
        )
      );
    }
    if (mine[c.id]) {
      actions.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "sc-action sc-action-danger",
            "aria-label": "Delete your comment",
            onclick: function () { deleteComment(c.id); },
          },
          [icon("trash"), "Delete"]
        )
      );
    }
    return el("article", { class: "sc-comment" + (c._pending ? " sc-is-pending" : ""), id: "comment-" + c.id }, [
      avatar(c),
      el("div", { class: "sc-main" }, [
        el("div", { class: "sc-meta" }, [
          el("strong", { class: "sc-name", text: c.name }),
          el("a", { class: "sc-time", href: "#comment-" + c.id, title: new Date(c.createdAt).toLocaleString(), text: timeAgo(c.createdAt) }),
          c._pending ? el("span", { class: "sc-badge", text: "Awaiting moderation" }) : null,
        ]),
        renderBody(c.body),
        actions,
      ]),
    ]);
  }

  function buildForm(maxBody) {
    var who = load("who", { name: "", email: "" });
    var status = el("p", { class: "sc-status", role: "status" });
    var cancel = el("button", {
      type: "button",
      class: "sc-action sc-cancel",
      text: "Cancel reply",
      onclick: function () { state.replyTo = null; root.insertBefore(formEl, listEl); renderList(); },
    });
    var form = el("form", { class: "sc-form", novalidate: true }, [
      el("textarea", { name: "body", rows: "4", maxlength: String(maxBody), required: true, placeholder: "Join the discussion…", "aria-label": "Comment" }),
      el("div", { class: "sc-row" }, [
        el("input", { name: "name", type: "text", maxlength: "60", placeholder: "Name", "aria-label": "Name", value: who.name, autocomplete: "name" }),
        el("input", { name: "email", type: "email", maxlength: "254", placeholder: "Email (optional, for Gravatar)", "aria-label": "Email", value: who.email, autocomplete: "email" }),
      ]),
      // Honeypot, hidden from people.
      el("input", { name: "website", type: "text", tabindex: "-1", autocomplete: "off", class: "sc-hp", "aria-hidden": "true" }),
      el("div", { class: "sc-row sc-submit-row" }, [
        el("button", { type: "submit", class: "sc-button", text: "Post comment" }),
        cancel,
      ]),
      status,
    ]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submit(form, status);
    });
    return form;
  }

  function focusForm() {
    var ta = formEl.querySelector("textarea");
    if (ta) ta.focus();
  }

  function submit(form, status) {
    var f = form.elements;
    var body = f.body.value.trim();
    if (!body) {
      status.textContent = "Write a comment first.";
      return;
    }
    var button = form.querySelector(".sc-button");
    button.disabled = true;
    status.textContent = "Posting…";
    save("who", { name: f.name.value.trim(), email: f.email.value.trim() });

    getTurnstileToken()
      .then(function (token) {
        return api("/api/comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: PAGE_URL,
            parentId: state.replyTo,
            name: f.name.value,
            email: f.email.value,
            body: body,
            website: f.website.value,
            turnstileToken: token,
          }),
        });
      })
      .then(function (res) {
        mine[res.comment.id] = { token: res.deleteToken, page: state.page, pending: res.pending, comment: res.pending ? res.comment : null };
        save("mine", mine);
        if (!res.pending) state.comments.push(res.comment);
        f.body.value = "";
        state.replyTo = null;
        root.insertBefore(formEl, listEl);
        renderList();
        status.textContent = res.pending ? "Thanks! Your comment will appear after review." : "";
        var node = document.getElementById("comment-" + res.comment.id);
        if (node) node.scrollIntoView({ block: "nearest" });
      })
      .catch(function (err) {
        status.textContent = err.message;
      })
      .then(function () {
        button.disabled = false;
      });
  }

  function deleteComment(id) {
    if (!confirm("Delete this comment?")) return;
    api("/api/comments/" + encodeURIComponent(id) + "?url=" + encodeURIComponent(PAGE_URL), {
      method: "DELETE",
      headers: { "X-Delete-Token": mine[id].token },
    })
      .then(function () {
        delete mine[id];
        save("mine", mine);
        return refresh();
      })
      .catch(function (err) {
        alert(err.message);
      });
  }

  function refresh() {
    return api("/api/comments?url=" + encodeURIComponent(PAGE_URL)).then(function (data) {
      state.page = data.page;
      state.comments = data.comments;
      renderList();
    });
  }

  // ---------- Styles ----------

  function injectStyles() {
    if (document.getElementById("sc-styles")) return;
    var css = [
      ".sc-root{--sc-fg:#1f2328;--sc-muted:#656d76;--sc-bg:#fff;--sc-soft:#f6f8fa;--sc-border:#d0d7de;--sc-accent:#0969da;--sc-accent-fg:#fff;--sc-danger:#cf222e;",
      "font:15px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--sc-fg);max-width:760px;margin:2rem 0}",
      ".sc-root[data-theme=dark]{--sc-fg:#e6edf3;--sc-muted:#8d96a0;--sc-bg:#0d1117;--sc-soft:#161b22;--sc-border:#30363d;--sc-accent:#4493f8;--sc-accent-fg:#0d1117;--sc-danger:#f85149}",
      "@media (prefers-color-scheme:dark){.sc-root[data-theme=auto]{--sc-fg:#e6edf3;--sc-muted:#8d96a0;--sc-bg:#0d1117;--sc-soft:#161b22;--sc-border:#30363d;--sc-accent:#4493f8;--sc-accent-fg:#0d1117;--sc-danger:#f85149}}",
      ".sc-root *{box-sizing:border-box}",
      ".sc-header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--sc-border);padding-bottom:.5rem;margin-bottom:1rem}",
      ".sc-count{font-weight:600;font-size:1.05rem;margin:0}",
      ".sc-form{display:grid;gap:.5rem;margin:0 0 1.5rem}",
      ".sc-comment .sc-form{margin:.75rem 0 .5rem}",
      ".sc-root .sc-form textarea,.sc-root .sc-form input{display:block!important;width:100%!important;height:auto!important;min-height:0;margin:0!important;font:inherit!important;line-height:1.4!important;color:var(--sc-fg)!important;background:var(--sc-bg)!important;border:1px solid var(--sc-border)!important;border-radius:6px!important;padding:.55rem .7rem!important;box-shadow:none!important}",
      ".sc-root .sc-form textarea{resize:vertical;min-height:5.5rem}",
      ".sc-root .sc-form textarea:focus,.sc-root .sc-form input:focus{outline:2px solid var(--sc-accent)!important;outline-offset:-1px;border-color:transparent!important}",
      ".sc-row{display:flex;gap:.5rem;flex-wrap:wrap}.sc-row input{flex:1 1 200px}",
      ".sc-submit-row{align-items:center}",
      ".sc-root .sc-button{display:inline-block!important;height:auto!important;min-width:0!important;margin:0!important;font:inherit!important;font-weight:600!important;line-height:1.4!important;letter-spacing:normal!important;text-transform:none!important;background:var(--sc-accent)!important;color:var(--sc-accent-fg)!important;border:0!important;border-radius:6px!important;box-shadow:none!important;padding:.55rem 1.1rem!important;cursor:pointer}",
      ".sc-root .sc-button:hover{filter:brightness(1.1)}",
      ".sc-root .sc-button:disabled{opacity:.6!important;cursor:default;pointer-events:none}",
      ".sc-root .sc-action{display:inline-flex!important;align-items:center;gap:.35rem;height:auto!important;min-width:0!important;margin:0!important;padding:.2rem .5rem!important;font:inherit!important;font-size:.8125rem!important;font-weight:500!important;line-height:1.4!important;letter-spacing:normal!important;text-transform:none!important;color:var(--sc-muted)!important;background:transparent!important;border:0!important;border-radius:6px!important;box-shadow:none!important;cursor:pointer;transition:color .15s,background-color .15s}",
      ".sc-root .sc-action:hover,.sc-root .sc-action:focus-visible{color:var(--sc-accent)!important;background:var(--sc-soft)!important;box-shadow:none!important}",
      ".sc-root .sc-action-danger:hover,.sc-root .sc-action-danger:focus-visible{color:var(--sc-danger)!important}",
      ".sc-root .sc-action:focus-visible{outline:2px solid var(--sc-accent);outline-offset:1px}",
      ".sc-root .sc-icon{flex:none;display:block}",
      ".sc-root .sc-cancel{display:none!important}.sc-root .sc-comment .sc-cancel{display:inline-flex!important}",
      ".sc-status{margin:0;font-size:.9rem;color:var(--sc-muted);min-height:1.2em}",
      ".sc-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0}",
      ".sc-comment{display:flex;gap:.75rem;margin:0 0 1.1rem;flex-wrap:wrap}",
      ".sc-comment>.sc-main{flex:1;min-width:0}",
      ".sc-comment>.sc-children{flex-basis:100%;padding-left:2.9rem}",
      ".sc-children.sc-flat{padding-left:0}",
      ".sc-avatar{width:2.2rem;height:2.2rem;border-radius:50%;flex:none;background:var(--sc-soft);object-fit:cover}",
      ".sc-initial{display:grid;place-items:center;font-weight:600;color:var(--sc-muted);border:1px solid var(--sc-border)}",
      ".sc-meta{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap;margin:0;font-size:.9rem}",
      ".sc-name{color:var(--sc-fg)}",
      ".sc-time{color:var(--sc-muted);text-decoration:none}.sc-time:hover{text-decoration:underline}",
      ".sc-badge{font-size:.75rem;background:var(--sc-soft);border:1px solid var(--sc-border);border-radius:999px;padding:0 .5rem;color:var(--sc-muted)}",
      ".sc-is-pending .sc-body{opacity:.7}",
      ".sc-deleted .sc-meta{color:var(--sc-muted);font-style:italic}",
      ".sc-body p{margin:.25rem 0;overflow-wrap:anywhere}.sc-body a{color:var(--sc-accent)}",
      ".sc-actions{display:flex;gap:.25rem;margin:.2rem 0 0 -.5rem}",
      ".sc-empty,.sc-error{color:var(--sc-muted)}",
      ".sc-footer{font-size:.8rem;color:var(--sc-muted);margin-top:1.5rem}",
    ].join("");
    document.head.appendChild(el("style", { id: "sc-styles", text: css }));
  }

  // ---------- Boot ----------

  injectStyles();
  root.classList.add("sc-root");
  root.setAttribute("data-theme", THEME);
  countEl = el("h2", { class: "sc-count", text: "Comments" });
  listEl = el("div", { class: "sc-list", "aria-live": "polite" }, [el("p", { class: "sc-empty", text: "Loading comments…" })]);
  root.textContent = "";
  root.appendChild(el("div", { class: "sc-header" }, [countEl]));

  api("/api/config")
    .then(function (cfg) {
      formEl = buildForm(cfg.maxBody || 5000);
      root.appendChild(formEl);
      root.appendChild(listEl);
      if (cfg.turnstileSiteKey) initTurnstile(cfg.turnstileSiteKey);
      return refresh();
    })
    .catch(function (err) {
      root.appendChild(el("p", { class: "sc-error", text: "Comments could not be loaded. " + err.message }));
    });
})();

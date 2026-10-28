import {
  HttpError,
  sha256,
  pageKey,
  listComments,
  countComments,
  getComment,
  insertComment,
  approveComment,
  removeComment,
  listPending,
  checkRateLimit,
  pruneRateLimits,
} from "./store.js";
import { sendMail } from "./smtp.js";

const MAX_NAME = 60;
const MAX_EMAIL = 254;
const MAX_BODY = 5000;
const LINK_RE = /https?:\/\/|www\./i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin"), env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    let res;
    try {
      res = await route(request, env, ctx, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      res = json({ error: status === 500 ? "Server error" : err.message }, status);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  // Daily cron (see wrangler.toml) clears expired rate-limit rows.
  async scheduled(event, env) {
    await pruneRateLimits(env);
  },
};

async function route(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/config" && method === "GET") {
    return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, maxBody: MAX_BODY });
  }
  if (pathname === "/api/comments" && method === "GET") return getComments(env, url);
  if (pathname === "/api/counts" && method === "GET") return getCounts(env, url);
  if (pathname === "/api/comments" && method === "POST") return postComment(request, env, ctx);

  const del = pathname.match(/^\/api\/comments\/([\w-]+)$/);
  if (del && method === "DELETE") return deleteOwnComment(request, env, url, del[1]);

  if (pathname.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    if (pathname === "/api/admin/pending" && method === "GET") return adminPending(env);
    if (pathname === "/api/admin/thread" && method === "GET") return adminThread(env, url);
    if (pathname === "/api/admin/moderate" && method === "POST") return adminModerate(request, env);
  }

  return json({ error: "Not found" }, 404);
}

// ---------- Public API ----------

async function getComments(env, url) {
  const { key } = pageKey(url.searchParams.get("url") || "");
  const comments = (await listComments(env, key)).map(publicView);
  return json({ page: key, count: comments.filter((c) => !c.deleted).length, comments });
}

// GET /api/counts?url=A&url=B  ->  { counts: { A: 3, B: 0 } }, keyed by the URLs as sent.
async function getCounts(env, url) {
  const urls = [...new Set(url.searchParams.getAll("url"))];
  if (urls.length > 100) throw new HttpError(400, "Too many URLs (max 100)");
  const keys = new Map();
  for (const u of urls) {
    try {
      keys.set(u, pageKey(u).key);
    } catch {
      // Skip invalid URLs instead of failing the whole batch.
    }
  }
  const byKey = await countComments(env, [...new Set(keys.values())]);
  const counts = Object.fromEntries(urls.map((u) => [u, byKey[keys.get(u)] || 0]));
  return json({ counts }, 200, "public, max-age=60");
}

async function postComment(request, env, ctx) {
  const origin = request.headers.get("Origin");
  if (!isAllowedOrigin(origin, env)) throw new HttpError(403, "Origin not allowed");

  const input = await readJson(request);
  const { key, origin: pageOrigin } = pageKey(String(input.url || ""));
  if (!isAllowedOrigin(pageOrigin, env)) throw new HttpError(403, "Page not allowed");

  // Honeypot: real users never see or fill this field.
  if (input.website) throw new HttpError(400, "Rejected");

  const name = clean(input.name, MAX_NAME) || "Anonymous";
  const body = clean(input.body, MAX_BODY, true);
  const email = clean(input.email, MAX_EMAIL).toLowerCase();
  if (!body) throw new HttpError(400, "Comment cannot be empty");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Invalid email");

  const ip = request.headers.get("CF-Connecting-IP") || "local";
  if (env.TURNSTILE_SECRET) await verifyTurnstile(env, input.turnstileToken, ip);
  await checkRateLimit(env, await sha256(`${env.HASH_SALT || ""}:${ip}`), Number(env.RATE_LIMIT_PER_HOUR || 10));

  const mode = env.MODERATION || "links";
  const held = mode === "all" || (mode === "links" && LINK_RE.test(body + " " + name));
  const deleteToken = randomHex(24);

  const comment = {
    id: crypto.randomUUID(),
    page: key,
    parentId: input.parentId ? String(input.parentId) : null,
    name,
    avatar: email ? await sha256(email) : null,
    body,
    createdAt: new Date().toISOString(),
    status: held ? "pending" : "approved",
    deleteTokenHash: await sha256(deleteToken),
  };
  await insertComment(env, comment);

  const adminUrl = new URL("/admin.html", request.url).href;
  if (env.NOTIFY_WEBHOOK_URL) ctx.waitUntil(notifyWebhook(env, key, comment));
  if (env.SMTP_HOST && env.NOTIFY_EMAIL) ctx.waitUntil(notifyEmail(env, key, comment, email, adminUrl));

  return json({ comment: publicView(comment), pending: held, deleteToken }, 201);
}

async function deleteOwnComment(request, env, url, id) {
  const { key } = pageKey(url.searchParams.get("url") || "");
  const token = request.headers.get("X-Delete-Token") || "";
  const c = await getComment(env, key, id);
  if (!c || !token || !c.deleteTokenHash || c.deleteTokenHash !== (await sha256(token))) {
    throw new HttpError(403, "Not allowed");
  }
  await removeComment(env, key, id);
  return json({ ok: true });
}

// ---------- Admin API ----------

async function adminPending(env) {
  const items = (await listPending(env)).map(adminView);
  return json({ items });
}

async function adminThread(env, url) {
  const raw = url.searchParams.get("url") || "";
  const key = /^https?:\/\//i.test(raw) ? pageKey(raw).key : raw;
  const comments = (await listComments(env, key, { includePending: true })).map(adminView);
  return json({ page: key, comments });
}

async function adminModerate(request, env) {
  const { page, id, action } = await readJson(request);
  if (!page || !id || !["approve", "delete"].includes(action)) throw new HttpError(400, "Bad request");
  if (action === "approve") await approveComment(env, page, id);
  else await removeComment(env, page, id);
  return json({ ok: true });
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) throw new HttpError(503, "ADMIN_TOKEN is not configured");
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  // Compare fixed-length digests so the check runs in constant time.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_TOKEN)),
  ]);
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new HttpError(401, "Unauthorized");
}

// ---------- Helpers ----------

function publicView(c) {
  const { id, parentId, name, avatar, body, createdAt, deleted } = c;
  return deleted ? { id, parentId, createdAt, deleted: true } : { id, parentId, name, avatar, body, createdAt };
}

function adminView(c) {
  const { deleteTokenHash, ...rest } = c;
  return rest;
}

function clean(value, max, multiline = false) {
  let s = String(value ?? "").normalize("NFC");
  // Strip control characters. Keep newlines and tabs in multiline fields.
  s = multiline ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "") : s.replace(/[\u0000-\u001F\u007F]/g, "");
  s = s.trim();
  if (s.length > max) throw new HttpError(400, `Field too long (max ${max} characters)`);
  return s;
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .includes(origin);
}

function corsHeaders(origin, env) {
  if (!isAllowedOrigin(origin, env)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Delete-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function verifyTurnstile(env, token, ip) {
  if (!token) throw new HttpError(400, "Please complete the verification");
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const data = await res.json();
  if (!data.success) throw new HttpError(400, "Verification failed");
}

async function notifyEmail(env, key, c, commenterEmail, adminUrl) {
  const held = c.status === "pending";
  const pageUrl = `https://${key}`;
  const lines = [
    `${c.name}${commenterEmail ? ` <${commenterEmail}>` : ""} ${c.parentId ? "replied" : "commented"} on ${pageUrl}`,
    "",
    c.body,
    "",
    "---",
    held ? `This comment is awaiting moderation: ${adminUrl}` : `View it: ${pageUrl}#comment-${c.id}`,
  ];
  try {
    await sendMail(
      {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.SMTP_FROM || env.SMTP_USER,
        fromName: env.SMTP_FROM_NAME || "Blog comments",
      },
      {
        to: env.NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean),
        subject: `${held ? "[Needs review] " : ""}New comment from ${c.name} on ${key}`,
        text: lines.join("\n"),
        // Lets you reply to the commenter straight from your inbox.
        replyTo: commenterEmail || undefined,
      }
    );
  } catch (err) {
    console.error("Email notification failed", err);
  }
}

async function notifyWebhook(env, key, c) {
  const text = `New comment${c.status === "pending" ? " awaiting moderation" : ""} on https://${key}\n${c.name}: ${c.body.slice(0, 500)}`;
  try {
    // `text` is read by Slack, `content` by Discord.
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
    });
  } catch (err) {
    console.error("Webhook failed", err);
  }
}

async function readJson(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > 20000) throw new HttpError(413, "Request too large");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

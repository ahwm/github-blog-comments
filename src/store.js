// D1 storage. Schema lives in migrations/.

const HOUR = 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Turn a page URL into a stable key: host + path, no query, hash, trailing slash or index.html.
export function pageKey(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "Invalid page URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Invalid page URL");
  let path = u.pathname.replace(/\/index\.html?$/, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return { key: u.host.toLowerCase() + path, origin: u.origin };
}

function toComment(row) {
  return {
    id: row.id,
    page: row.page,
    parentId: row.parent_id,
    name: row.name,
    avatar: row.avatar,
    body: row.body,
    createdAt: row.created_at,
    status: row.status,
    deleted: !!row.deleted,
    deleteTokenHash: row.delete_token_hash,
  };
}

export async function listComments(env, page, { includePending = false } = {}) {
  const sql = includePending
    ? "SELECT * FROM comments WHERE page = ? ORDER BY created_at"
    : "SELECT * FROM comments WHERE page = ? AND status = 'approved' ORDER BY created_at";
  const { results } = await env.DB.prepare(sql).bind(page).all();
  return results.map(toComment);
}

// Visible comment counts for up to 100 pages (D1's bound-parameter limit).
export async function countComments(env, pages) {
  if (!pages.length) return {};
  const placeholders = pages.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT page, COUNT(*) AS n FROM comments
     WHERE status = 'approved' AND deleted = 0 AND page IN (${placeholders})
     GROUP BY page`
  )
    .bind(...pages)
    .all();
  return Object.fromEntries(results.map((r) => [r.page, r.n]));
}

export async function getComment(env, page, id) {
  const row = await env.DB.prepare("SELECT * FROM comments WHERE page = ? AND id = ?").bind(page, id).first();
  return row ? toComment(row) : null;
}

// Inserts only if the parent (when given) exists on the same page and is approved.
export async function insertComment(env, c) {
  const res = await env.DB.prepare(
    `INSERT INTO comments (id, page, parent_id, name, avatar, body, created_at, status, delete_token_hash)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE ?3 IS NULL OR EXISTS (
       SELECT 1 FROM comments WHERE id = ?3 AND page = ?2 AND status = 'approved' AND deleted = 0
     )`
  )
    .bind(c.id, c.page, c.parentId, c.name, c.avatar, c.body, c.createdAt, c.status, c.deleteTokenHash)
    .run();
  if (!res.meta.changes) throw new HttpError(400, "Parent comment not found");
}

export async function approveComment(env, page, id) {
  const res = await env.DB.prepare("UPDATE comments SET status = 'approved' WHERE page = ? AND id = ?")
    .bind(page, id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "Comment not found");
}

// Comments with replies become tombstones so the thread keeps its shape. Others are removed.
export async function removeComment(env, page, id) {
  const hasReplies = "EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = comments.id)";
  const [tomb, del] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE comments SET name = '', avatar = NULL, body = '', deleted = 1, status = 'approved', delete_token_hash = NULL
       WHERE page = ? AND id = ? AND ${hasReplies}`
    ).bind(page, id),
    env.DB.prepare(`DELETE FROM comments WHERE page = ? AND id = ? AND NOT ${hasReplies}`).bind(page, id),
  ]);
  if (!tomb.meta.changes && !del.meta.changes) throw new HttpError(404, "Comment not found");
}

export async function listPending(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM comments WHERE status = 'pending' ORDER BY created_at LIMIT 500"
  ).all();
  return results.map(toComment);
}

// Fixed one-hour window per IP. The upsert is a single statement, so it is atomic.
export async function checkRateLimit(env, ipHash, limit) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (ip_hash, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT (ip_hash) DO UPDATE SET
       count        = CASE WHEN ?2 - window_start > ?3 THEN 1  ELSE count + 1   END,
       window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END
     RETURNING count`
  )
    .bind(ipHash, now, HOUR)
    .first();
  if (row.count > limit) throw new HttpError(429, "Too many comments. Try again later.");
}

export async function pruneRateLimits(env) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Date.now() - HOUR).run();
}

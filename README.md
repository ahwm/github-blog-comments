# static-comments

Disqus-style comments for static sites (GitHub Pages, etc.). Runs on one Cloudflare Worker and stores data in D1 (Cloudflare’s SQLite database). No tracking, no ads, no third-party accounts.

## Features

- One `<script>` tag embed with threaded replies, Gravatar or initial avatars, relative times, light/dark themes.
- Moderation modes: publish immediately, hold comments with links, or hold everything.
- Admin page at `/admin.html` to approve or delete comments.
- Commenters can delete their own comments from the same browser.
- Spam controls: honeypot field, per-IP hourly rate limit, optional Cloudflare Turnstile.
- Optional email (SMTP) or Slack/Discord notifications for new comments.
- Origin allowlist, so only your sites can post.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create static-comments   # copy the database_id into wrangler.toml
npm run db:migrate                      # creates the tables
npx wrangler secret put ADMIN_TOKEN     # long random string
npx wrangler secret put HASH_SALT       # another random string
```

Edit `wrangler.toml` and set `ALLOWED_ORIGINS` to your site, for example `https://you.github.io`. Use the origin only, no path. Then:

```bash
npx wrangler deploy
```

## Embed

Add this where comments should appear:

```html
<div id="comments"></div>
<script src="https://static-comments.YOUR-SUBDOMAIN.workers.dev/embed.js" async></script>
```

Script tag options:

| Attribute | Default | Purpose |
|---|---|---|
| `data-container` | `comments` | id of the element to render into |
| `data-url` | canonical link, else `location.href` | page to thread comments on |
| `data-theme` | `auto` | `light`, `dark` or `auto` |

Threads are keyed by host + path. Query strings, hashes, trailing slashes and `index.html` are ignored, so `/post/`, `/post` and `/post/index.html` share one thread.

For Jekyll, put the snippet in `_layouts/post.html`.

## Comment counts

For index or archive pages, add `data-comment-count` to any element and load `count.js` once:

```html
<a href="/my-post/#comments" data-comment-count>Comments</a>
<span data-comment-count="https://you.github.io/other-post/"></span>
<script src="https://static-comments.YOUR-SUBDOMAIN.workers.dev/count.js" async></script>
```

Each element uses its `data-comment-count` value as the page URL, else its `href`, else the current page. Relative URLs are fine. All counts on a page load in one request. Counts are cached for 60 seconds.

To change the wording, set `data-zero`, `data-one` and `data-many` on the script tag. `{n}` becomes the number, for example `data-many="{n} replies"`.

## Configuration

`[vars]` in `wrangler.toml`:

| Name | Default | Notes |
|---|---|---|
| `ALLOWED_ORIGINS` | | Comma-separated origins allowed to post |
| `MODERATION` | `links` | `none`, `links` or `all` |
| `TURNSTILE_SITE_KEY` | empty | Public key. Needs `TURNSTILE_SECRET` too |
| `RATE_LIMIT_PER_HOUR` | `10` | Comments per IP per hour |

Secrets (`npx wrangler secret put NAME`): `ADMIN_TOKEN`, `HASH_SALT`, `TURNSTILE_SECRET`, `NOTIFY_WEBHOOK_URL`, `SMTP_PASS`.

To turn on Turnstile, create a widget in the Cloudflare dashboard with your site's hostname. Put the site key in `TURNSTILE_SITE_KEY` and the secret in `TURNSTILE_SECRET`. The widget stays invisible unless Cloudflare needs the visitor to interact.

## Email notifications

Get an email for each new comment through any SMTP server. Add these to `[vars]` in `wrangler.toml`:

```toml
SMTP_HOST = "smtp.example.com"
SMTP_PORT = "587"
SMTP_USER = "you@example.com"
SMTP_FROM = "comments@example.com"   # optional, defaults to SMTP_USER
SMTP_FROM_NAME = "Blog comments"     # optional
NOTIFY_EMAIL = "you@example.com"     # comma-separated for several recipients
```

Then store the password as a secret:

```bash
npx wrangler secret put SMTP_PASS
```

- Use port 587 (STARTTLS) or 465 (TLS). Cloudflare blocks port 25 from Workers.
- `SMTP_SECURE` is optional: `starttls`, `tls` or `none`. It defaults to `tls` on port 465 and `starttls` otherwise.
- AUTH PLAIN and AUTH LOGIN are supported. For Gmail or Microsoft 365, use an app password.
- Held comments get a `[Needs review]` subject and a link to the admin page.
- When the commenter gave an email, it is set as `Reply-To`, so you can reply from your inbox.
- A failed send is logged (`npx wrangler tail`) and never blocks the comment.

Email and the webhook can be used together or separately.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/config` | Turnstile key and limits |
| GET | `/api/comments?url=` | Approved comments for a page |
| GET | `/api/counts?url=A&url=B` | Visible comment counts, up to 100 URLs |
| POST | `/api/comments` | `{ url, parentId?, name?, email?, body, turnstileToken? }` |
| DELETE | `/api/comments/:id?url=` | Header `X-Delete-Token` from the POST response |
| GET | `/api/admin/pending` | Bearer `ADMIN_TOKEN` |
| GET | `/api/admin/thread?url=` | Bearer `ADMIN_TOKEN`. All comments, including held |
| POST | `/api/admin/moderate` | Bearer `ADMIN_TOKEN`. `{ page, id, action: "approve" \| "delete" }` |

## Storage

Two tables, defined in `migrations/0001_init.sql`:

- `comments`: one row per comment, indexed by page. Held comments have `status = 'pending'`.
- `rate_limits`: one row per hashed IP with an hourly counter. A daily cron clears old rows.

Each write is a single SQL statement, so simultaneous posts are safe. Replies are only accepted when the parent is approved and on the same page. Deleting a comment that has replies leaves a "deleted" placeholder so the thread keeps its shape.

To add schema changes, create `migrations/0002_*.sql` and run `npm run db:migrate`.

To query directly:

```bash
npx wrangler d1 execute static-comments --remote --command "SELECT page, COUNT(*) FROM comments GROUP BY page"
```

What is stored: name, comment text, time, and a SHA-256 hash of the email if one was given. Raw emails and IPs are never stored. Note that the email hash is public, since Gravatar needs it.

## Local development

```bash
npm run db:migrate:local
npm run dev     # Worker on http://localhost:8787
npm run demo    # demo post on http://localhost:8080, index page at /list
```

`.dev.vars` holds local settings (admin token `dev-admin-token`). It is git-ignored.

On Windows, if `wrangler dev` fails with `SQLITE_CANTOPEN`, the project path is too long. Add `--persist-to C:/tmp/sc` to both the migrate and dev commands.

## Limits

- No accounts, voting, editing or email notifications to commenters.
- Rate limiting is per IP and approximate. It is not a hard guarantee.

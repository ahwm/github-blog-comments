// Minimal SMTP client over Cloudflare TCP sockets. Supports STARTTLS (587), implicit TLS (465)
// and AUTH PLAIN / LOGIN. Port 25 is blocked on Workers, so use 587 or 465.

import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(text) {
  let bin = "";
  for (const byte of enc.encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// RFC 2047 encoded-word, so names and subjects can hold any Unicode.
function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;
}

function formatAddress(name, email) {
  if (!name) return `<${email}>`;
  const clean = name.replace(/["\\\r\n]/g, "");
  const display = /^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : encodeHeader(clean);
  return `${display} <${email}>`;
}

function assertSafe(value, field) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

class Connection {
  constructor(socket) {
    this.use(socket);
  }

  use(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buffer = "";
  }

  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }

  async readLine() {
    while (!this.buffer.includes("\r\n")) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP connection closed");
      this.buffer += dec.decode(value, { stream: true });
    }
    const i = this.buffer.indexOf("\r\n");
    const line = this.buffer.slice(0, i);
    this.buffer = this.buffer.slice(i + 2);
    return line;
  }

  // Reads a full reply, including multi-line "250-..." continuations.
  async reply(expected) {
    const lines = [];
    let line;
    do {
      line = await this.readLine();
      lines.push(line.slice(4));
    } while (line[3] === "-");
    const code = Number(line.slice(0, 3));
    if (expected && !expected.includes(code)) {
      throw new Error(`SMTP error ${code}: ${lines.join(" ")}`);
    }
    return { code, lines };
  }

  async send(line) {
    await this.writer.write(enc.encode(line + "\r\n"));
  }

  async command(line, expected) {
    await this.send(line);
    return this.reply(expected);
  }
}

// cfg: { host, port, secure: "starttls" | "tls" | "none", user, pass, from, fromName }
// msg: { to: string[], subject, text, replyTo? }
export async function sendMail(cfg, msg) {
  const port = Number(cfg.port || 587);
  const secure = cfg.secure || (port === 465 ? "tls" : "starttls");
  const transport = { tls: "on", starttls: "starttls", none: "off" }[secure];
  if (!transport) throw new Error(`Unknown SMTP_SECURE value "${secure}"`);

  const from = assertSafe(cfg.from, "SMTP_FROM");
  const to = msg.to.map((t) => assertSafe(t, "recipient"));
  const heloName = from.split("@")[1] || "localhost";

  const socket = connect({ hostname: cfg.host, port }, { secureTransport: transport, allowHalfOpen: false });
  const conn = new Connection(socket);

  try {
    await conn.reply([220]);
    let ehlo = await conn.command(`EHLO ${heloName}`, [250]);

    if (secure === "starttls") {
      await conn.command("STARTTLS", [220]);
      conn.release();
      conn.use(conn.socket.startTls());
      ehlo = await conn.command(`EHLO ${heloName}`, [250]);
    }

    if (cfg.user) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || "";
      if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
        await conn.command(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass || ""}`)}`, [235]);
      } else {
        await conn.command("AUTH LOGIN", [334]);
        await conn.command(b64(cfg.user), [334]);
        await conn.command(b64(cfg.pass || ""), [235]);
      }
    }

    await conn.command(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of to) await conn.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    await conn.command("DATA", [354]);

    const headers = [
      `From: ${formatAddress(cfg.fromName, from)}`,
      `To: ${to.map((t) => `<${t}>`).join(", ")}`,
      msg.replyTo ? `Reply-To: <${assertSafe(msg.replyTo, "Reply-To")}>` : null,
      `Subject: ${encodeHeader(assertSafe(msg.subject, "subject"))}`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${crypto.randomUUID()}@${heloName}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
    ].filter(Boolean);

    // Base64 lines never start with ".", so no dot-stuffing is needed.
    const body = b64(msg.text.replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
    await conn.writer.write(enc.encode(headers.join("\r\n") + "\r\n\r\n" + body + ".\r\n"));
    await conn.reply([250]);
    await conn.command("QUIT").catch(() => {});
  } finally {
    try {
      await conn.socket.close();
    } catch {}
  }
}

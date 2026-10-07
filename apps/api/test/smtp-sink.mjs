// A tiny SMTP server for tests: accepts every message and keeps it in memory (no TLS, no auth).
import { createServer } from "node:net";

/** Decodes the quoted-printable bodies nodemailer writes, so tests can read links. */
function decodeQp(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export async function startSmtpSink() {
  const messages = [];
  const server = createServer((sock) => {
    let buf = "";
    let inData = false;
    let msg = { from: "", to: [], raw: "" };
    sock.write("220 sink ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          msg.raw = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          const head = msg.raw.split("\r\n\r\n")[0];
          const subject = /^Subject: (.*)$/m.exec(head)?.[1] ?? "";
          const text = decodeQp(msg.raw);
          messages.push({ from: msg.from, to: msg.to, subject, text, links: [...text.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0].replace(/&amp;/g, "&")) });
          msg = { from: "", to: [], raw: "" };
          sock.write("250 OK queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-sink\r\n250 8BITMIME\r\n");
        else if (cmd === "MAIL") (msg.from = /<(.*)>/.exec(line)?.[1] ?? ""), sock.write("250 OK\r\n");
        else if (cmd === "RCPT") msg.to.push(/<(.*)>/.exec(line)?.[1] ?? ""), sock.write("250 OK\r\n");
        else if (cmd === "DATA") (inData = true), sock.write("354 End with <CRLF>.<CRLF>\r\n");
        else if (cmd === "QUIT") sock.end("221 Bye\r\n");
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    messages,
    /** Waits for a message to an address (optionally matching the subject). */
    async next(to, subject = "", timeoutMs = 5000) {
      const t0 = Date.now();
      for (;;) {
        const i = messages.findIndex((m) => m.to.includes(to) && m.subject.includes(subject));
        if (i >= 0) return messages.splice(i, 1)[0];
        if (Date.now() - t0 > timeoutMs) throw new Error(`no email to ${to} (${subject})`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

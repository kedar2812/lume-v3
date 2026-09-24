// A minimal SMTP server (the RFC 5321 happy path) so invite and reset emails are really sent, plus a
// tiny HTTP API to read what arrived. Test infrastructure only; it keeps messages in memory.
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";

const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3110);
const HTTP_PORT = Number(process.env.E2E_MAIL_API_PORT ?? 3111);
const messages = [];

/** Undo quoted-printable soft breaks and escapes, so links read as the recipient sees them. */
const unQuotedPrintable = (s) =>
  s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

createTcp((socket) => {
  let buffer = "";
  let data = null;
  let to = [];
  const send = (line) => socket.write(`${line}\r\n`);
  send("220 lume-e2e sink");
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\r\n"); nl !== -1; nl = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      if (data !== null) {
        if (line === ".") {
          const raw = data.join("\r\n");
          const subject = /^Subject: (.*)$/im.exec(raw)?.[1] ?? "";
          messages.push({ to, subject, text: unQuotedPrintable(raw), at: new Date().toISOString() });
          data = null;
          to = [];
          send("250 OK");
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        continue;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) send("250 lume-e2e");
      else if (upper.startsWith("RCPT TO")) {
        to.push(/<(.+)>/.exec(line)?.[1] ?? line.slice(8).trim());
        send("250 OK");
      } else if (upper === "DATA") {
        data = [];
        send("354 End with <CRLF>.<CRLF>");
      } else if (upper === "QUIT") {
        send("221 Bye");
        socket.end();
      } else if (upper === "RSET") {
        to = [];
        send("250 OK");
      } else send("250 OK"); // MAIL FROM, NOOP and anything else
    }
  });
  socket.on("error", () => socket.destroy());
}).listen(SMTP_PORT, "127.0.0.1");

createHttp((req, res) => {
  if (req.url !== "/messages") return res.writeHead(404).end();
  if (req.method === "DELETE") {
    messages.length = 0;
    return res.writeHead(204).end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(messages));
}).listen(HTTP_PORT, "127.0.0.1", () => console.log(`smtp sink on ${SMTP_PORT}, mail api on ${HTTP_PORT}`));

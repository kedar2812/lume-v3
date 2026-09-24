// One origin for the browser: /api/* (and the health checks) → the API, everything else → Next.
// Mirrors infra/Caddyfile, so cookies, CSRF and redirects behave exactly as they do in production.
import { createServer, request } from "node:http";

const API = Number(process.env.E2E_API_PORT ?? 3101);
const WEB = Number(process.env.E2E_WEB_PORT ?? 3102);
const PORT = Number(process.env.E2E_EDGE_PORT ?? 3100);
const toApi = (url) => /^\/(api|webhooks)\//.test(url) || url === "/healthz" || url === "/readyz";

createServer((req, res) => {
  const proxied = request(
    {
      host: "127.0.0.1",
      port: toApi(req.url) ? API : WEB,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress ?? "127.0.0.1" },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  });
  req.pipe(proxied);
}).listen(PORT, "127.0.0.1", () => console.log(`edge on ${PORT} → api ${API} / web ${WEB}`));

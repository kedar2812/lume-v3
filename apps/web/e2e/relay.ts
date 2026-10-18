// The real connect relay for e2e (WhatsApp, plan W1 Task 11), with Meta pointed at the fake: Embedded Signup's
// hand-back and Meta's deliveries run through the same code a client's server meets. Google isn't used here.
import http from "node:http";
import { createRelay } from "../../connect/src/relay";

export const E2E_RELAY_TOKEN = "e2e-relay-token-0123456789-abcdefghij";
const port = Number(process.env.E2E_RELAY_PORT ?? 3115);
const edge = Number(process.env.E2E_EDGE_PORT ?? 3100);
const meta = `http://127.0.0.1:${process.env.E2E_META_PORT ?? 3114}`;
http
  .createServer(
    createRelay({
      publicUrl: `http://127.0.0.1:${port}`,
      clientId: "e2e-client",
      clientSecret: "e2e-client-secret",
      pickerKey: "e2e-picker",
      appId: "1",
      secret: "e2e-relay-secret-0123456789-abcdefghij",
      instances: [{ url: `http://127.0.0.1:${edge}`, token: E2E_RELAY_TOKEN }],
      meta: {
        appId: "1234567890",
        appSecret: "meta-app-secret-for-tests",
        configId: "987654321",
        verifyToken: "verify-token-for-tests",
        graphUrl: meta,
        version: "v23.0",
      },
    }),
  )
  .listen(port, "127.0.0.1", () => console.log(`relay on ${port}`));

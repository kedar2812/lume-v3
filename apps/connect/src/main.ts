// The Connect with Google relay (2B spec §6), hosted once by the owner at connect.lumecrm.in. It holds the
// OAuth client secret and the Picker key; every LUME instance talks to it with its own token.
import http from "node:http";
import { z } from "zod";
import { createRelay } from "./relay";

const env = z
  .object({
    RELAY_PUBLIC_URL: z.url({ protocol: /^https?$/ }),
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(10),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(10),
    GOOGLE_PICKER_API_KEY: z.string().min(10),
    GOOGLE_PROJECT_NUMBER: z.string().regex(/^\d+$/),
    RELAY_SECRET: z.string().min(32),
    RELAY_INSTANCES: z
      .string()
      .transform((s, ctx) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "must be JSON" });
          return z.NEVER;
        }
      })
      .pipe(z.array(z.object({ url: z.url({ protocol: /^https?$/ }), token: z.string().min(32) }))),
    PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  })
  .safeParse(process.env);

if (!env.success) {
  console.error("The relay can't start; fix these settings:");
  for (const i of env.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
  process.exit(1);
}
const c = env.data;
http
  .createServer(
    createRelay({
      publicUrl: c.RELAY_PUBLIC_URL.replace(/\/$/, ""),
      clientId: c.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: c.GOOGLE_OAUTH_CLIENT_SECRET,
      pickerKey: c.GOOGLE_PICKER_API_KEY,
      appId: c.GOOGLE_PROJECT_NUMBER,
      secret: c.RELAY_SECRET,
      instances: c.RELAY_INSTANCES,
    }),
  )
  .listen(c.PORT, "0.0.0.0", () =>
    console.log(`relay listening on ${c.PORT} for ${c.RELAY_INSTANCES.length} instance(s)`),
  );

// The fake Google for e2e (spec 2B §11): the API's own test fake, on a fixed port, its key written where
// api-server.mjs reads it. No test ever calls Google.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { startGoogleFake } from "../../api/test/google-fake";

// Bundled into e2e/.artifacts/ and run from there, so the key goes next to the bundle.
const here = import.meta.dirname;
const dir = here.endsWith(".artifacts") ? here : path.join(here, ".artifacts");
const fake = await startGoogleFake({ port: Number(process.env.E2E_GOOGLE_PORT ?? 3112) });
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "google-key.b64"), fake.env);
console.log(`google fake on ${fake.url}`);

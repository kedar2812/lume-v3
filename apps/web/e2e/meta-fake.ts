// The fake Meta for e2e (WhatsApp, plan W1 Task 11): the API's own test fake, on a fixed port. The relay and the API
// both call it; tests drive it through /__fake/*. No test ever calls Meta.
import { startMetaFake } from "../../api/test/meta-fake";

const fake = await startMetaFake({ port: Number(process.env.E2E_META_PORT ?? 3114) });
console.log(`meta fake on ${fake.url}`);

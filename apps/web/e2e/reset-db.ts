import path from "node:path";
import { resetE2eDatabase } from "./db";

// Bundled and run before the API starts (the API decides at boot whether to print a setup token).
await resetE2eDatabase(path.resolve(process.argv[2] ?? "../.."));
console.log("e2e database reset: lume_e2e is empty and migrated");

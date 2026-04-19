import { runAtom } from "./src/index.js";

runAtom().catch((err) => {
  console.error("[pi-coral-agent] fatal:", err);
  process.exit(1);
});

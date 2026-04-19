import { runAtom } from "./src/index.js";

runAtom({
  atomName: process.env.CORAL_AGENT_ID ?? "pi-coral-agent",
  localTools: [],
}).catch((err) => {
  console.error("[pi-coral-agent] fatal:", err);
  process.exit(1);
});

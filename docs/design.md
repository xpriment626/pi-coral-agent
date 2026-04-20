# pi-coral-agent — Tier 1 Design

**Status:** Implemented — see [plans/2026-04-19-tier1-strip.md](plans/2026-04-19-tier1-strip.md) and [spikes/tier1-validation-result.md](spikes/tier1-validation-result.md).
**Date:** 2026-04-19
**Goal:** First reusable TypeScript template for CoralOS agents, at parity with Koog (Kotlin), coral-rs (Rust), and LangChain (Python).

## Why this exists

CoralOS ships three official agent templates — Koog, coral-rs, LangChain — and no TypeScript option. Application developers on the TS ecosystem currently have to roll their own runtime, which leads to reinventing pieces the Coral server already provides (system prompt composition, instruction adaptation per toolset, session lifecycle). This template fills that gap.

Coral templates are distributed as **clone-target agents**: each official template repo IS a directly-registerable Coral agent. Developers clone the template repo, rename/customize via `coral-agent.toml` options, optionally extend the entry point with their own tools, then link with `coralizer link .`. pi-coral-agent follows this convention so a TS developer can `git clone`, `coralizer link`, and have a working agent — same flow as Koog.

The design follows from a docs audit (see `docs/references/`) that distinguished **what Coral provides natively** from **what the template must provide**. Everything Coral provides is delegated. The template earns its keep on: MCP client boilerplate, the LLM loop, environment parsing, tool schema bridging, and debug artifact capture — in that order of load-bearingness.

## Scope

**In scope (Tier 1):**

- Root `coral-agent.toml` making the template directly registerable (edition 4, `path`+`arguments` runtime schema matching known-good local conventions)
- Root `index.ts` entry point invoked by `npx tsx index.ts` per the toml
- MCP connection over streamable HTTP (`connectCoralMcp`)
- Tool schema sanitizer + name remapping for OpenAI-safe identifiers (`sanitizeJsonSchema`, `remapToolName`)
- Coral environment variable parsing (`readCoralEnv`)
- pi-mono LLM loop integration (`runAgentLoop` via `runAtom`)
- Initial user turn helper (Koog-parity preamble, optional override)
- Per-turn debug artifact writer with secret redaction (`writeIterationArtifact`)
- All `coral_*` tools exposed from turn 1; no gating

**Out of scope (deferred to Tier 2/3):**

- Per-atom state machine scaffold
- Runtime-driven finalize / idempotency latches
- Outer session-lifetime loop
- Mention composition helpers (echoing seed `from` field etc.)
- customTools webhook registration helper
- Session-close (`coral_close_session`) wrapper
- Domain-specific message envelope schemas (e.g. atom_request/atom_result)

These are omitted deliberately. They're either not yet needed by consumers, or (more importantly) they're patterns best validated in a real consumer before being promoted into the template. Consumers that need them can build them atop Tier 1.

## Phase 0 — verification spike (BLOCKS strip)

**Claim to verify:** the Coral docs state that the server will expand `<resource uri="coral://..."/>` tags in an agent's system prompt automatically. Exact quote (features/resources.md):

> System prompt injection (recommended): Server replaces `<resource>` tags in agent prompts automatically.

**Why this blocks the strip:** if true, `buildSystemPrompt`'s manual resource fetch + injection is dead code and the whole fixture-1 byte-equality test disappears. If false, we keep a slimmed `buildSystemPrompt` and the ambition to delegate prompt composition narrows significantly. The Tier 1 API shape is the same either way, but the internals differ.

**Spike procedure:**

1. Create a minimal dummy atom (`pi-coral-agent/spikes/resource-expansion/` — archived 2026-04-20; raw evidence at `docs/spikes/artifacts/`) with a coral-agent.toml registering it against local Coral Server.
2. System prompt configured via `SYSTEM_PROMPT` option contains literal `<resource uri="coral://state"/>` — no manual expansion by the atom.
3. Atom runs one LLM turn, writing the exact systemPrompt that goes to the model into a debug artifact.
4. Compare against current behavior (with manual expansion): does the model see the resource body or the literal `<resource uri="..."/>` tag?
5. Record finding in `pi-coral-agent/docs/spikes/resource-expansion-result.md`.

**Decision rule:** spike outcome determines whether `buildSystemPrompt` is deleted or retained (simplified) in the strip phase.

## Clone-target shape

After cloning pi-coral-agent, a developer sees:

```
my-atom/
├── coral-agent.toml       # edit: name, version, default SYSTEM_PROMPT, add domain options
├── index.ts               # optionally extend: add atom-specific tools
├── package.json
├── tsconfig.json
└── src/                   # template internals — do not typically edit
    ├── coral-mcp.ts
    ├── env.ts
    ├── debug.ts
    ├── prompt.ts
    ├── runtime.ts
    └── index.ts           # named exports for library-style consumers
```

**Default entry point** (`index.ts` at repo root, invoked by `coral-agent.toml`'s `[runtimes.executable]`):

```ts
import { runAtom } from "./src/index.js";

runAtom().catch((err) => {
  console.error("[atom] fatal:", err);
  process.exit(1);
});
```

Zero-customization path: just change `coral-agent.toml` options (name, system prompt, API keys). Most atoms need nothing more.

**Extension path** — atoms with domain-specific tools edit `index.ts` to pass them through:

```ts
import { runAtom } from "./src/index.js";
import { myDomainTools } from "./tools.js";

runAtom({
  tools: myDomainTools,
  secretsFromEnv: [process.env.HELIUS_API_KEY ?? ""],
}).catch((err) => {
  console.error("[atom] fatal:", err);
  process.exit(1);
});
```

`systemPrompt` stays in the toml as a session-configurable option; the runtime reads it from `env.SYSTEM_PROMPT`. Passing `systemPrompt:` to `runAtom` is an override for advanced cases only.

## Internal API (`runAtom`)

The entry point calls one function:

```ts
runAtom({
  systemPrompt?: string,       // override env.SYSTEM_PROMPT
  tools?: AgentTool<any>[],    // atom-specific tools merged with coral_*
  secretsFromEnv?: string[],   // extra strings to redact from debug artifacts
})
```

Everything else — connection URL, agent ID, session ID, model config — comes from Coral-injected env vars via `readCoralEnv`.

Secondary exports (`src/index.ts`, for library-style consumers):

- `connectCoralMcp`, `mcpToolsToAgentTools`, `sanitizeJsonSchema`, `remapToolName` — bypass `runAtom` and drive the loop manually
- `readCoralEnv` — read env without running
- `buildUserTurn` — the Koog-parity initial preamble (consumers may override via their own string)
- `writeIterationArtifact`, `redactSecrets` — debug helpers

## File-by-file fate

| File | Action | Rationale |
|---|---|---|
| `coral-agent.toml` (root) | **Create** | Makes the template directly registerable as a Coral agent. Edition 4, `path`+`arguments` runtime schema per working local conventions |
| `index.ts` (root) | **Create** | Entry point invoked by `npx tsx index.ts` per toml. One-liner calling `runAtom()` from `src/index.ts` |
| `src/coral-mcp.ts` | Keep, minor cleanup | MCP client + schema bridge is load-bearing and clean |
| `src/env.ts` | Keep, clarify `CORAL_PROMPT_SYSTEM` precedence | Near-final; only precedence with `SYSTEM_PROMPT` option needs spelled out |
| `src/debug.ts` | Keep, generalize | Drop the Solana-specific 88-char base58 regex; leave only the OpenAI-style `sk-*` pattern plus explicit secrets-from-env |
| `src/pi-runtime.ts` | **Strip** 272 → ~80 lines | Drop `FIRST_TURN_TOOL_BLOCKLIST`, `createToolReadmitHandler`, resource-fetching in `prepareFirstTurn`. Depending on Phase 0, also drop `buildSystemPrompt` call |
| `src/prompt.ts` | `buildSystemPrompt` **deleted** (pending Phase 0); `buildUserTurn` kept as helper | The Koog preamble text remains useful; consumers may use or bypass it |
| `src/messages.ts` | **Moved to solana-coralised** | Domain convention, not template concern — no other Coral template ships a payload schema |
| `src/pi-runtime.test.ts` | Strip 49 tests → ~12 | Delete fixture-2 predicate tests, tool readmit tests; keep MCP/env/payload/redaction tests |
| `src/prompt.test.ts` | **Deleted** | Fixture-1 byte-equality against Kotlin is a non-goal once `buildSystemPrompt` dies |
| `src/index.ts` | Update to stripped surface | Barrel re-exports for library-style consumers; root `index.ts` imports from here |

## Proposed stripped `runAtom`

Rough shape (Phase 0 outcome will refine):

```ts
export async function runAtom(config: RunAtomConfig): Promise<void> {
  const env = readCoralEnv();
  const modelApiKey = requireApiKey();
  const model = getModel(resolveProvider(), resolveModelId());

  const coral = await connectCoralMcp(env.CORAL_CONNECTION_URL, env.CORAL_AGENT_ID);

  try {
    const allTools = [...coral.tools, ...(config.tools ?? [])];
    const systemPrompt = resolveSystemPrompt(config.systemPrompt, env);

    const agentContext: AgentContext = {
      systemPrompt,
      messages: [],
      tools: allTools,  // all tools from turn 1 — no gating
    };

    const secrets = collectSecretsForRedaction(env, modelApiKey, config.secretsFromEnv);

    let iteration = 0;
    const emit = async (ev: AgentEvent) => {
      if (ev.type !== "turn_end") return;
      iteration += 1;
      await writeIterationArtifact({
        atomName: env.CORAL_AGENT_ID,
        sessionId: env.CORAL_SESSION_ID,
        iteration,
        secretsFromEnv: secrets,
        payload: buildIterationPayload({
          iteration,
          agent: { state: { systemPrompt: agentContext.systemPrompt } },
          event: {
            ...ev,
            toolNamesAvailable: (agentContext.tools ?? []).map((t) => t.name),
          },
        }),
      });
    };

    const initialUserTurn = buildUserTurn({
      iteration: 0,
      extraInitialUserPrompt: env.EXTRA_INITIAL_USER_PROMPT,
      followupUserPrompt: env.FOLLOWUP_USER_PROMPT,
    });

    const loopConfig: AgentLoopConfig = {
      model,
      convertToLlm: (messages) => messages as any,
      getApiKey: async () => modelApiKey,
    };

    await runAgentLoop(
      [{ role: "user", content: [{ type: "text", text: initialUserTurn }], timestamp: Date.now() }],
      agentContext,
      loopConfig,
      emit
    );
  } finally {
    await coral.close();
  }
}
```

~60 lines vs the current 272. No `prepareFirstTurn` staging, no `createToolReadmitHandler`, no first-turn blocklist, no manual `<resource>` expansion if Phase 0 confirms server-side handling.

## Testing strategy

**Keep (target ~12 tests):**

- `coral-mcp.ts`: schema sanitizer edge cases, tool name remap round-trip
- `env.ts`: required vars, optional vars, `CORAL_PROMPT_SYSTEM` vs `SYSTEM_PROMPT` precedence
- `debug.ts`: artifact path composition, secret redaction (by env, by `sk-*` pattern), redaction is deep-walked through arrays/objects
- `pi-runtime.ts`: iteration payload shape, emit writes artifact on turn_end
- `prompt.ts`: `buildUserTurn` initial vs followup branches

**Delete:**

- All fixture-1 byte-equality tests (`prompt.test.ts`)
- Fixture-2 predicate tests (runtime-composed send, idempotency latch, fallback finalize, state extractor)
- `createToolReadmitHandler` tests
- `FIRST_TURN_TOOL_BLOCKLIST` tests

**Add (after Phase 0 lands):**

- One live-integration test proving a dummy atom receives a puppet-seeded message and the resolved system prompt contains the expanded state resource. Becomes the permanent replacement for fixture-1.

## Success criterion

A dummy atom registered with the local Coral server can:

1. Connect via MCP when launched by the server
2. Receive a puppet-seeded message in a thread
3. Produce at least one LLM turn with `coral_*` tools + its atom-specific tools visible to the model
4. Write a readable debug artifact per turn_end with secrets redacted

All using nothing but `runAtom({ systemPrompt, tools })` plus a `coral-agent.toml`.

**Validation plan:** port the existing `market-trends` atom in solana-coralised to the stripped template by hand-copy. If the port fits in ≤50 lines of atom code (excluding tools), Tier 1 is done. If it overflows because the atom needs state or finalize logic, that's the signal that Tier 2 is justified — and we have evidence, not speculation, to design Tier 2 against.

## Execution phases

1. **Phase 0 — scaffold template agent shape.** Root `coral-agent.toml` + root `index.ts`. Verify registerability via `coralizer link .`. This is the Koog-shape the template needs before it's a template.
2. **Phase 1 — verification spike.** Resolve `<resource>` tag handling. Blocks all stripping.
3. **Phase 2 — strip `pi-runtime.ts`.** Delete blocklist, readmit handler, fixture-2 machinery. Keep tests green as you go.
4. **Phase 3 — resolve prompt.ts.** Based on Phase 1, either delete `buildSystemPrompt` or simplify it. Delete `prompt.test.ts` byte-equality.
5. **Phase 4 — move `messages.ts` to solana-coralised.** One commit, two repos.
6. **Phase 5 — generalize `debug.ts`.** Drop Solana regex.
7. **Phase 6 — consolidate `src/index.ts`.** Final public API surface for library-style consumers.
8. **Phase 7 — live validation.** Link the template root, run a session with a default or session-override SYSTEM_PROMPT, verify end-to-end receive + reply.

Each phase ends with a commit. Phase 1 produces a spike doc; phases 0, 2–7 produce code.

## Out-of-scope considerations (intentional omissions)

- **No provider abstraction beyond what pi-mono offers.** Keep pi-mono + `getModel` as-is. A `model: { provider, id }` param on `runAtom` is Tier 2.
- **No packaging or publish.** Template is consumed by manual copy for v1. `package.json` stays `private: true`.
- **No streaming UX work.** Debug artifacts are JSON files, not an event bus.
- **No CLI.** `npm create pi-coral-agent` is Tier 3.

## References

- `docs/references/ts-coral-framework/thesis.md` — original framework thesis
- `docs/references/coral-koog-runtime-patterns.md` — Kotlin reference patterns
- `docs/references/handoffs/runtime-driven-finalize.md` — fixture-2 archival context
- CoralOS docs audit (in conversation memory): `project_ts_template_intent.md` in auto-memory
- Official docs: https://docs.coralos.ai/ (features/resources.md, concepts/coordination.md, guides/writing-agents.md)

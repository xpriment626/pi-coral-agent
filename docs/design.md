# pi-coral-agent — Tier 1 Design

**Status:** Draft, pending user review.
**Date:** 2026-04-19
**Goal:** First reusable TypeScript template for CoralOS agents, at parity with Koog (Kotlin), coral-rs (Rust), and LangChain (Python).

## Why this exists

CoralOS ships three official agent templates — Koog, coral-rs, LangChain — and no TypeScript option. Application developers on the TS ecosystem currently have to roll their own runtime, which leads to reinventing pieces the Coral server already provides (system prompt composition, instruction adaptation per toolset, session lifecycle). This template fills that gap.

The design follows from a docs audit (see `docs/references/`) that distinguished **what Coral provides natively** from **what the template must provide**. Everything Coral provides is delegated. The template earns its keep on: MCP client boilerplate, the LLM loop, environment parsing, tool schema bridging, and debug artifact capture — in that order of load-bearingness.

## Scope

**In scope (Tier 1):**

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

1. Create a minimal dummy atom (`pi-coral-agent/spikes/resource-expansion/`) with a coral-agent.toml registering it against local Coral Server.
2. System prompt configured via `SYSTEM_PROMPT` option contains literal `<resource uri="coral://state"/>` — no manual expansion by the atom.
3. Atom runs one LLM turn, writing the exact systemPrompt that goes to the model into a debug artifact.
4. Compare against current behavior (with manual expansion): does the model see the resource body or the literal `<resource uri="..."/>` tag?
5. Record finding in `pi-coral-agent/docs/spikes/resource-expansion-result.md`.

**Decision rule:** spike outcome determines whether `buildSystemPrompt` is deleted or retained (simplified) in the strip phase.

## API surface (Tier 1)

Single entry point:

```ts
import { runAtom } from "pi-coral-agent";
import { myAtomKitTools } from "./my-tools.js";

await runAtom({
  // Optional — falls back to env.SYSTEM_PROMPT if omitted.
  // Should contain <resource uri="coral://instruction"/> and <resource uri="coral://state"/>
  // tags; whether those expand client-side or server-side is decided by Phase 0.
  systemPrompt: "You are a market trends atom that surfaces trending pools.",

  // Atom-specific tools merged with Coral's coral_* tools at startup.
  tools: myAtomKitTools,

  // Optional — additional strings to redact from debug artifacts.
  secretsFromEnv: [process.env.HELIUS_API_KEY ?? ""],
});
```

That's the whole consumer-facing API. Everything else — connection URL, agent ID, session ID, prompt options — comes from Coral-injected env vars.

Secondary exports (advanced/debug use only):

- `connectCoralMcp`, `mcpToolsToAgentTools`, `sanitizeJsonSchema`, `remapToolName` — usable for consumers that want to bypass `runAtom` and drive the loop themselves
- `readCoralEnv` — for consumers that want to read env without running
- `buildUserTurn` — the Koog-parity initial preamble (consumers may override via their own string)
- `writeIterationArtifact`, `redactSecrets` — debug helpers

## File-by-file fate

| File | Action | Rationale |
|---|---|---|
| `src/coral-mcp.ts` | Keep, minor cleanup | MCP client + schema bridge is load-bearing and clean |
| `src/env.ts` | Keep, clarify `CORAL_PROMPT_SYSTEM` precedence | Near-final; only precedence with `SYSTEM_PROMPT` option needs spelled out |
| `src/debug.ts` | Keep, generalize | Drop the Solana-specific 88-char base58 regex; leave only the OpenAI-style `sk-*` pattern plus explicit secrets-from-env |
| `src/pi-runtime.ts` | **Strip** 272 → ~80 lines | Drop `FIRST_TURN_TOOL_BLOCKLIST`, `createToolReadmitHandler`, resource-fetching in `prepareFirstTurn`. Depending on Phase 0, also drop `buildSystemPrompt` call |
| `src/prompt.ts` | `buildSystemPrompt` **deleted** (pending Phase 0); `buildUserTurn` kept as helper | The Koog preamble text remains useful; consumers may use or bypass it |
| `src/messages.ts` | **Moved to solana-coralised** | Domain convention, not template concern — no other Coral template ships a payload schema |
| `src/pi-runtime.test.ts` | Strip 49 tests → ~12 | Delete fixture-2 predicate tests, tool readmit tests; keep MCP/env/payload/redaction tests |
| `src/prompt.test.ts` | **Deleted** | Fixture-1 byte-equality against Kotlin is a non-goal once `buildSystemPrompt` dies |
| `src/index.ts` | Update to stripped surface | Export only what Tier 1 exposes |

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

1. **Phase 0 — verification spike.** Resolve `<resource>` tag handling. Blocks all stripping.
2. **Phase 1 — strip `pi-runtime.ts`.** Delete blocklist, readmit handler, fixture-2 machinery. Keep tests green as you go.
3. **Phase 2 — resolve prompt.ts.** Based on Phase 0, either delete `buildSystemPrompt` or simplify it. Delete `prompt.test.ts` byte-equality.
4. **Phase 3 — move `messages.ts` to solana-coralised.** One commit, two repos.
5. **Phase 4 — generalize `debug.ts`.** Drop Solana regex.
6. **Phase 5 — consolidate `index.ts`.** Final public API surface.
7. **Phase 6 — port market-trends atom from solana-coralised.** Validation.

Each phase ends with a commit. Phase 0 produces a spike doc; phases 1–6 produce code.

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

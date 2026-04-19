# TS Coral Framework: Thesis

## Context

This note exists because the pairwise smoke test for the Solana capability
atoms surfaced a pattern that isn't Solana-specific. The atoms connected,
ran tools, but never sent Coral messages — classic `message_non_execution`.
Reading the working compliance-demo Kotlin agents
(`/Users/bambozlor/Desktop/content-lab/compliance-demo/coral-sanctions-agent`)
made the root cause obvious: those agents aren't better prompted, they're
better *architected*. Each Kotlin agent runs a per-agent state machine on
top of the LLM loop — runtime-managed tools, runtime-driven finalization,
runtime-authored final messages. The model makes judgment calls; the
runtime owns flow control.

The observation that matters at the framework level: **there is no TS
equivalent to this.** Koog agents ship with runtime plumbing as a library.
Every TS Coral agent today reinvents the runtime. That is why most working
Coral demos are Kotlin.

This repo was going to build market-data atoms for Solana. Halfway through,
it became clear the reusable artifact isn't the atoms — it's the runtime
shape underneath them. That runtime shape is a candidate for the missing
TS-side framework.

Primary forward-deployed use case stays Solana-specific (coralising SendAI
Agent Kit). The framework generalization is dual-purpose: it serves this
use case faithfully *and* produces infrastructure that closes the polyglot
gap for Coral OS overall.

## Observations

### State of TS Coral agents today

- No published framework. The MCP SDK + Vercel AI SDK + handwritten loop
  is the pattern across every TS Coral agent I've inspected in-team.
- Koog carries concrete library surface (`AIAgent`, `functionalStrategy`,
  `PromptExecutor`, `McpToolRegistryProvider`,
  `requestLLMOnlyCallingTools`, `ClaimHandler`, `injectedWithMcpResources`).
  TS agents reimplement each of these per project, usually incompletely.
- The capability-atoms experiment in this repo reproduced the prompt
  composers and the iteration loop from Koog but did not reproduce the
  runtime state machine — which is the thing that actually makes agents
  behave reliably. Result: atoms ran tools but never sent messages.

### What the Kotlin sanctions agent actually does that we missed

Reference: `coral-sanctions-agent/src/main/kotlin/ai/coralprotocol/coral/koog/fullexample/Main.kt`.

- `ScreeningWorkflowState` — typed Kotlin data class, per-agent, mutated
  by the runtime from observed tool results.
- `RUNTIME_MANAGED_THREAD_TOOLS` — set of tool names the model is allowed
  to call only via the runtime. Model tool calls for these names are
  replaced with rejection results carrying an explicit reason.
- Per-tool budget enforcement (`MAX_DILISENSE_CHECKS`, `hasClearMatch`) —
  model-side tool calls filtered before execution when state says the
  budget is spent.
- `sendFinalScreeningResult` — runtime composes the final JSON from state
  and posts it via `coral_send_message`. Never asks the model.
- `sendRealtimeToolStatus` — runtime auto-posts per-iteration status
  snippets to a tracking thread so the Console/frontend has live activity.
- `sanitizeTavilyCall` / `compactDilisenseResultContent` — runtime fixes
  invalid args and shrinks tool results before they re-enter context.
- Batch mode (`runBatchSanctionsScreening`) — when input carries many
  subjects, bypass the LLM loop entirely and run the screening
  deterministically in Kotlin.

None of the above lives in the prompt. All of it is framework code.

### What the atoms-runtime worktree already provides (approx. layer 1)

Concrete files, `src/runtime/` unless noted:

- `env.ts` — Coral env var reader with structured failure for missing values.
- `atom-template.ts` — `startAtom` bootstrap: MCP connect, tool merge,
  loop invocation, clean exit.
- `tools.ts` — `LocalTool`/`LocalToolRegistry`, built-in `atom_noop`,
  `buildLocalRegistry`, `mergeRegistries`, OpenAI-compatible name
  validator (`^[a-zA-Z0-9_-]+$`).
- `coral-tools.ts` — MCP `client.listTools` → `LocalToolRegistry`, with
  JSON-Schema sanitizer that strips out-of-range numeric bounds (Kotlin
  `Long` defaults break OpenAI otherwise).
- `prompt.ts` — `buildSystemPrompt` + `buildUserTurn` with
  `<resource>…</resource>` expansion (Koog parity).
- `messages.ts` — Zod schemas + builders for `atom_request` / `atom_result`
  and a `sendAtomMessage` wrapper.
- `debug.ts` — per-iteration artifact writer with secret redaction.
- `loop.ts` — the iteration loop, failure-budget guardrail, `toolChoice:
  "required"` + `maxSteps: 1` semantics.
- `src/agent-kit/adapter.ts` + `envelope.ts` — generic Agent Kit action →
  `LocalTool` adapter with a normalized `{tool, status, data, warnings,
  source}` result envelope. Already handles thrown errors and soft-fail
  shapes.
- `src/evaluation/` — `RunArtifact` schema + writer and a harness that
  reads `.coral-debug/` artifacts plus the Coral thread state to emit
  failure-mode-tagged run artifacts.

### What's missing for a framework claim (layer 2+)

- State-machine hooks (`init`, `observe`, `shouldFinalize`, `buildResult`).
- Runtime-managed tool set declaration. Today the model can call every
  merged tool on every turn; framework should split `modelExposed` from
  `runtimeManaged` and reject the latter with a visible reason.
- Runtime-driven finalization (`buildResult` → `sendAtomMessage` from the
  loop, not the model).
- Optional per-iteration progress posts (like `sendRealtimeToolStatus`).
- Per-call sanitization hook and per-result compaction hook.
- Model provider abstraction. OpenAI is hardcoded; need a `ModelProvider`
  interface with at least OpenAI / Anthropic / OpenRouter adapters.
- Dev runtime: local mock Coral Server sufficient to iterate on the state
  machine without launching Gradle. Koog's equivalent is `DevMain.kt`.
- In-memory test harness: scripted tool results → state machine →
  asserted terminal state. Koog has nothing equivalent; TS has clean
  Vitest/mocks territory.
- CLI: `coral-agent init`, `coral-agent dev`, `coral-agent eval`.
- Claim / billing handler analogue.
- Plugin loading strategy for Agent Kit and similar packages with known
  ESM resolution bugs (we hit `@bonfida/spl-name-service` during Solana
  atoms; workaround was `createRequire`, but a framework-level story
  would be durable).

### Proposed layering

**Layer 1 — `@coral-protocol/agent-runtime-core`**
No opinions on flow. Today's `src/runtime/` minus `loop.ts`. Re-exportable
primitives for anyone who wants to build their own loop.

**Layer 2 — `@coral-protocol/agent-loop`**
The state-machine loop. Surface:

```ts
defineAgent<TState>({
  init: () => TState,
  observe: (state: TState, toolResult: ToolResult) => TState,
  shouldFinalize: (state: TState) => boolean,
  buildResult: (state: TState) => AtomResult,
  tools: {
    modelExposed: LocalToolRegistry,
    runtimeManaged: Set<string>, // names model may not call directly
  },
  sanitize?: (call: ToolCall) => ToolCall,
  compact?: (result: ToolResult) => ToolResult,
  progressPosts?: boolean,
})
```

Exports `runAgent(config)`. Equivalent in scope to Koog's
`functionalStrategy` surface area.

**Layer 3 — opinionated packages**
`@coral-protocol/agent-tools-agent-kit`,
`@coral-protocol/agent-tools-mcp-generic`,
`@coral-protocol/agent-model-openai` / `-anthropic` / `-openrouter`,
`@coral-protocol/agent-cli`.

### Packaging decision (per Option C)

Framework lives in this repo as workspace packages
(`packages/agent-runtime-core`, `packages/agent-loop`, etc.) alongside
the Solana atoms, which become the first consumer. Solana atoms shift
from `src/runtime/` imports to `@coral-protocol/agent-*` imports against
local workspace versions. If/when Coral org wants to adopt, the packages
extract cleanly to their own repo under the Coral Protocol org with
existing history intact.

Option B extraction pressure is deferred to whenever a second project
(Coral-internal or external) wants to consume the packages independently.

### Evaluation bar

**Primary:** coralise the full SendAI Agent Kit plugin surface. The
Solana market-data slice (5 atoms from `@solana-agent-kit/plugin-misc`
and `-plugin-token`) is the smallest viable slice. Beyond it:

- Read-only Solana atoms spanning CoinGecko, Helius DAS, Pyth, Jupiter
  market data, Messari, Elfa AI, Birdeye (~10-15 atoms).
- Wallet-scoped read atoms (owner holdings, transaction history) (~3-5).
- Write/sign atoms requiring policy middleware — transfers, swaps,
  staking, NFT mint (~15-25). These are deferred until the framework
  has a policy-middleware story, but their existence in Agent Kit means
  the framework must not over-index on read-only semantics.

**Secondary** (evidence the pattern generalizes beyond Solana):

- One Coral-native non-Solana atom (e.g. a Tavily-backed web-research
  atom, or a GitHub PR-metadata atom) running the same framework.
- One molecule that mixes Solana + non-Solana atoms in the same session.

The framework claim is earned at roughly the 10-atom threshold across
at least two domains. Below that we're still in proof-of-concept
territory.

## Open Questions

- State-machine pattern vs agentic/open-ended use cases. For atoms with
  a clean "fetch + synthesize + send" shape the pattern is a near-perfect
  fit; for agents whose value is open-ended exploration (e.g. a research
  agent that may keep searching indefinitely until satisfied), the
  `shouldFinalize` predicate feels forced. Is there a second primitive —
  a "turn-budget-with-synthesis" pattern — that complements, rather than
  replaces, the state machine? Or is open-ended behavior inherently not
  the atom pattern?
- Model provider abstraction depth. Option 1: thin wrapper over Vercel
  AI SDK's existing provider system, so the framework is "bring your own
  AI SDK provider". Option 2: `ModelProvider` interface that hides Vercel
  AI SDK, so future provider shifts (native Anthropic SDK, direct
  OpenRouter, local models) are framework-internal. Option 1 ships
  sooner; option 2 ages better.
- Streaming vs non-streaming. Koog is fundamentally per-iteration sync.
  Some TS consumers (Console-driven UIs, realtime chat) may want
  token-level streaming into progress posts. The framework can leave
  this to layer 3 initially but needs to not actively prevent it.
- Claim / billing handler scope. SendAI Agent Kit operations have no
  native cost model, but Coral's claim handler assumes per-token billing.
  Is `ClaimHandler` a layer-2 concern, a layer-3 plugin, or deferred
  until Coral payment integration is the priority?
- Policy middleware for sign atoms. The write/sign portion of Agent Kit
  eval bar presumes simulation + approval gates + spending limits. Is
  that framework-level (layer 2, atoms declare risk + runtime enforces
  policy) or plugin-level (layer 3, each sign atom assembles its own
  policy)?
- Versioning. Coral Server protocol evolves; Agent Kit evolves;
  Vercel AI SDK evolves; MCP SDK evolves. Framework's stability surface
  vs its dependency churn is a real maintenance question — especially
  given Option C's single-maintainer start.
- Atom state-machine taxonomy. Do atoms share a vocabulary (common
  phases like `awaiting_mention`, `fetching`, `synthesizing`,
  `finalized`) that the framework endorses, or is the state shape
  entirely per-atom? A shared taxonomy helps observability and
  Console rendering; a per-atom shape maximizes flexibility.
- Plugin loading story. SendAI plugins today have transitive-dep ESM
  issues. `createRequire` is a workaround, not a plan. Does the framework
  adopt an opinion (CJS-first? bundler?) or leave it to layer 3?

## Hypotheses

These are claims the first implementation slice can confirm or reject.
Each should be testable at specific atom counts.

- **H1.** The state-machine pattern generalizes to the read-only portion
  of SendAI Agent Kit with no framework extensions. Test: 10 read-only
  atoms built against layer 2 land without requiring changes to the
  `defineAgent` surface.
- **H2.** Runtime-managed tools + runtime-driven finalization eliminate
  `message_non_execution` as a class of failure. Test: zero occurrences
  in the next 10 live runs across ≥3 atom types.
- **H3.** Typed state hooks produce measurably better DX than Koog's
  closure-based state. Test: new atom time-to-first-run (green path)
  falls below the median for Koog template agents. Subjective bar but
  measurable via time-stamped commits on a fresh atom scaffold.
- **H4.** Coralising write/sign Agent Kit actions requires a policy
  middleware layer the framework does not yet have. Test: attempt to
  port `TRANSFER_SOL` and surface what's missing; expect simulation,
  approval-gate, and spending-limit gaps.
- **H5.** Option C (workspace packages) is sufficient through the first
  10 atoms. Extraction pressure (Option B) appears when a second
  project consumes the framework or when Coral team expresses intent
  to co-maintain. Test: review after every 5 atoms shipped.
- **H6.** The molecule compiler + pairwise-test harness we already built
  are largely framework-agnostic and can move into
  `@coral-protocol/agent-molecule` unchanged. Test: extraction diff
  should not require runtime-code modification.

## Links

- Kotlin reference agent:
  `/Users/bambozlor/Desktop/content-lab/compliance-demo/coral-sanctions-agent/src/main/kotlin/ai/coralprotocol/coral/koog/fullexample/Main.kt`
- Kotlin prompt/resource utils:
  `/Users/bambozlor/Desktop/content-lab/compliance-demo/coral-sanctions-agent/src/main/kotlin/ai/coralprotocol/coral/koog/fullexample/util/coral/CoralMCPUtils.kt`
- Existing atom template spec:
  `docs/superpowers/specs/2026-04-17-capability-atoms-single-agent-template-koog-parity-design.md`
- Existing molecule composition spec:
  `docs/superpowers/specs/2026-04-17-capability-atoms-molecule-composition-runtime-design.md`
- First pairwise run observations:
  `docs/decomposition/capability-atoms/pairwise-first-run.md`
- Failure-mode taxonomy:
  `docs/decomposition/capability-atoms/failure-mode-taxonomy.md`
- Current runtime implementation: `src/runtime/`, `src/agent-kit/`,
  `src/evaluation/` in this worktree.
- SendAI Agent Kit v2: https://github.com/sendaifun/solana-agent-kit
- Koog agents library (for parity checks, moving target):
  https://github.com/Coral-Protocol/coral-koog-agent
- Coral Server (source of protocol truth, also moving):
  https://github.com/Coral-Protocol/coral-server

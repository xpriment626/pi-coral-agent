# Coral Koog Runtime Patterns

This note summarizes what current Kotlin/Koog Coral agents do well enough that the TypeScript + Vercel AI SDK runtime should learn from them.

Sources reviewed:

- Local compliance demo: `/Users/bambozlor/Desktop/content-lab/compliance-demo`
- Koog template: `https://github.com/Coral-Protocol/coral-koog-agent`
- Coral examples: `https://github.com/Coral-Protocol/agents/tree/main/koog`

## Why This Matters

Coral is framework-agnostic at the registry/runtime level: anything with a valid `coral-agent.toml` can be discovered and launched. In practice, the team-supported path is currently strongest in Kotlin through Koog. If this repo is going to stress-test the interoperability thesis with TypeScript + Vercel AI SDK, the TS runtime should intentionally reproduce the Koog patterns that make Coral agents reliable before inventing new behavior.

## Koog Template Shape

The current Koog template is a full autonomous agent shell, not a one-shot mention responder.

Important defaults:

- `coral-agent.toml` exposes runtime controls: `MAX_ITERATIONS`, `ITERATION_DELAY_MS`, `MAX_TOKENS`, model provider, model id, base URL override, system prompt, and extra prompts.
- The system prompt includes Coral resources:
  - `<resource>coral://instruction</resource>`
  - `<resource>coral://state</resource>`
- `Main.kt` connects to the Coral MCP server over Streamable HTTP.
- Koog converts Coral MCP tools into a `ToolRegistry`.
- Local tools and Coral tools are placed into one combined registry.
- The agent runs a bounded loop for `maxIterations`.
- Each iteration refreshes Coral resources into the system prompt.
- The LLM is asked for tool calls via `requestLLMOnlyCallingTools`.
- Tool calls are executed and tool results are appended back into the conversation state.
- The full prompt is written to `agent_log.json` for debugging.
- Token usage is tracked and optionally claimed through Coral payment budget logic.

This is the core loop to emulate in TS:

```text
connect to Coral MCP
discover Coral tools
merge local capability tools
repeat maxIterations:
  refresh coral://instruction and coral://state
  ask model for tool calls only
  execute tool calls
  append tool results to model context
  write debug trace
  enforce token / budget / delay limits
```

## Coral Resources Are Central

The Koog pattern does not hardcode all Coral coordination instructions in every agent prompt. Instead it injects server-provided resources. The server builds `coral://instruction` from snippets required by the tools available to that agent:

- base Coral role
- thread messaging
- mentions
- waiting tools

The practical implication: the TS runtime should read and inject `coral://instruction` and `coral://state` rather than relying only on a static handcrafted prompt. This makes TS behavior closer to Koog and keeps Coral tool semantics server-owned.

## Tool-Only Iteration Beats One-Shot Text Generation

Koog uses `requestLLMOnlyCallingTools`, then extracts and executes tool calls. That is materially different from the previous TS runtime, which called `generateText` once per mention and hoped the model chose useful tools.

For atom agents, the TS equivalent should bias toward:

- model returns tool calls
- runtime executes tools
- runtime appends results
- only explicit Coral messages are visible to other agents

This matters because Coral agents do not communicate through assistant text. Messages only matter if sent through `coral_send_message`.

## Compliance Demo Pattern

The local compliance demo is more advanced than the public template. It uses Koog, but also adds deterministic workflow code around the LLM.

Observed patterns:

- **Source atoms:** sanctions, PEP, and adverse-media agents perform narrow checks with local tools plus Coral tools.
- **Aggregator:** risk-scoring agent waits for outputs from configured source agents and synthesizes a final decision.
- **Tracking threads:** agents create or reuse named tracking threads such as `sanctions-tracking-*`, `am-tracking-*`, or `risk-scoring-*`.
- **Runtime-managed thread tools:** some agents reject or intercept model attempts to call `coral_create_thread` or `coral_send_message`, then perform those actions deterministically in runtime code.
- **Status messages:** source agents send `[auto-status]` updates into tracking threads after tool execution.
- **Structured outputs:** agents send JSON objects into Coral threads rather than prose-first summaries.
- **Finalization guards:** agents track `finalSent`, max checks, max wait cycles, and fallback final decisions.
- **Partial-result tolerance:** the risk-scoring agent can finalize after enough source responses or after wait-cycle exhaustion.
- **Debug traces:** deterministic workflow state is written to `agent_log.json`, not just raw LLM prompt traces.

This pattern is not “pure atom emergence.” It is a pragmatic hybrid: atom agents are narrow, but runtime code actively prevents common failure modes.

## What To Borrow For TS

The TS runtime should borrow these features early:

1. **Session-level loop, not mention-level loop**
   - Run for `maxIterations`.
   - Refresh Coral state each iteration.
   - Let waiting tools participate inside the loop.

2. **Coral resource injection**
   - Read `coral://instruction`.
   - Read `coral://state`.
   - Rebuild the system prompt with fresh resources.

3. **Tool-only model turns**
   - Prefer model calls that are required to produce tool calls where possible.
   - Treat plain assistant text as debug-only unless sent via `coral_send_message`.

4. **Runtime-owned guardrails**
   - Cap local tool attempts.
   - Cap total iterations.
   - Cap tokens or model steps.
   - Reject tool calls that violate atom boundaries.

5. **Structured Coral messages**
   - Atom outputs should be JSON-first.
   - Include `agent`, `kind`, `status`, `input`, `result`, `handoffs`, and `limitations`.

6. **Debug artifacts**
   - Write prompt trace and compact workflow state.
   - Keep these files ignored or written to a known debug directory.

7. **Fallback finalization**
   - If an atom cannot complete, it should send a structured failure or partial result rather than silently timing out.

## What Not To Copy Blindly

The compliance demo contains domain-specific deterministic orchestration. That is useful, but it can also weaken the atom/molecule experiment if copied too aggressively.

For this repo:

- Do not start with a central aggregator equivalent to `coral-rs-agent`.
- Do not let one atom secretly own the whole molecule.
- Do not hide all handoffs in deterministic runtime code before testing whether agents can route messages themselves.
- Do not make thread creation completely LLM-owned if reliability depends on a tracking thread. Prefer a small deterministic thread helper with explicit experiment notes.

The right starting point is a constrained hybrid:

```text
runtime provides loop, resource injection, tool execution, logging, and safety rails
atoms decide whether to answer or hand off within their small contract
molecule test records whether handoffs actually work
```

## Implications For The First Two Atoms

For `market-trends` and `token-info`, the first TS runtime should support:

- One atom manifest per agent.
- One combined tool registry containing Coral MCP tools and that atom's Agent Kit actions.
- A bounded autonomous loop.
- Fresh `coral://instruction` and `coral://state` injection each iteration.
- A system prompt that says the atom owns only its listed actions.
- A message contract requiring JSON output through `coral_send_message`.
- Optional handoff hints, but no full molecule coordinator.
- A Console-compatible `coral-agent.toml` so the atom can be launched through normal Coral Server session creation.
- Runtime options declared in the manifest rather than hidden only in local harness code.

Minimum message shapes:

```json
{
  "kind": "atom_request",
  "task_id": "string",
  "from": "agent-name",
  "to": "agent-name",
  "capability": "market-trends | token-info",
  "input": {}
}
```

```json
{
  "kind": "atom_result",
  "task_id": "string",
  "agent": "agent-name",
  "status": "success | partial | error",
  "result": {},
  "handoffs": [
    {
      "to": "token-info",
      "reason": "candidate token needs enrichment",
      "input": {}
    }
  ],
  "limitations": []
}
```

## Design Questions Before Implementation

1. Should the TS runtime force all model turns to be tool calls, or allow a final non-tool turn only for summarization that must be wrapped into `coral_send_message`?
2. Should tracking thread creation be runtime-owned for atom experiments, or should the initiating agent create threads through normal Coral tool calls?
3. Should atoms receive a peer capability registry in prompt, or discover peers only through `coral://state`?
4. How much deterministic handoff execution should runtime perform before it becomes an orchestrator?
5. Should pair tests use a puppet as molecule initiator, or should `market-trends` initiate handoff to `token-info` directly?
6. What is the minimum Console template shape needed to launch the same pairwise test without custom local-only assumptions?

## Near-Term Recommendation

Write the initial runtime design around Koog parity:

- bounded loop
- resource refresh
- tool-only turns
- tool result append
- structured Coral messages
- debug traces

Then implement a two-atom vertical slice and explicitly record where TS behavior diverges from Koog.

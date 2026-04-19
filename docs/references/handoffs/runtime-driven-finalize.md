# Handoff — runtime-driven finalize (fixture-2 on pi-mono)

**Written:** 2026-04-18 (end of iter-N expansion session)
**For:** next fresh session, to continue the pi-mono port by implementing the send-path contract defined in fixture-2

## What's already done (baseline you inherit)

Master is at merge `a93b925` (tag `pi-mono-iter-n-expansion-green`). Fixture-1 predicates 1, 2, and 3 are all live-proven in session `7c66ab49-83fc-4544-ae66-8aec90f96ab6`. See `project_solana_aat_status.md` for the detailed build state.

What the runtime does today:

- `src/runtime/pi-runtime.ts` drives `runAgentLoop` directly (not pi-mono's `Agent` class) so we own `AgentContext` across turns.
- `prepareFirstTurn` pre-loads `coral://instruction` + `coral://state` into the system prompt and filters the three `coral_wait_*` primitives for iter-0 only.
- `createToolReadmitHandler` re-admits wait primitives into `context.tools` on the first `turn_end` via in-place mutation (the only pattern that propagates through `runAgentLoop`'s spread-cloned `currentContext`).
- Debug artifacts per iter capture `systemPrompt`, the pi-mono event, and `toolNamesAvailable` as observed from `agentContext.tools`.
- `coral_send_message` is in the tool list at all iters (not a wait tool, not on the blocklist). Today the model chooses whether and when to call it.

What the runtime does NOT do today:

- It does NOT intercept `coral_send_message` or `coral_create_thread` from the model.
- It does NOT maintain any workflow state object — everything is in the model's transcript.
- It does NOT compose or post any final message itself.
- There is no idempotency latch on send; nothing prevents the model from emitting multiple sends.
- There is no fallback finalize for the iteration ceiling case.

## What fixture-2 asks for

See `docs/fixtures/coral-wire-traces/02-compliance-demo-runtime-spec/README.md`. The five predicates a TS runtime must satisfy:

1. **Tool gate.** `coral_send_message` and `coral_create_thread` are intercepted before execution when the model calls them. A structured rejection result (with reason) flows back into the transcript.
2. **State extracted from tool results.** Runtime maintains a typed state object mutated from tool results, not from assistant text.
3. **Runtime composes and posts final.** The single real `coral_send_message` call is issued by the runtime with args derived from the state object.
4. **Idempotent latch.** A `finalSent`-equivalent flag prevents duplicate sends.
5. **Fallback finalize.** If iteration ceiling is hit without state reaching the terminal predicate, fallback send with partial state.

Predicates 1, 3, and 4 are non-negotiable. 2 is replaceable with model-output parsing but reintroduces the failure mode 1 exists to prevent. 5 is best-practice.

## Where the pi-mono hooks live

`runAgentLoop` accepts an `AgentLoopConfig` with these relevant fields (see `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts` lines 77–200):

- `beforeToolCall(context, signal)` → can return `{ block: true, result }` to intercept before execution. **This is where predicate 1 lives.**
- `afterToolCall(context, signal)` → can override the executed tool result. **This is where predicate 2's state extraction lives.**
- `getFollowUpMessages()` → runtime-injected user messages that fire after the agent would stop. Candidate for predicate 5 (fallback) but also see next bullet.
- Our own `emit` handler on `turn_end` events is the natural place for predicate 3 (runtime-driven finalize). The handler already owns `agentContext`; it can read the workflow state, check the terminal predicate, and when satisfied call `coral.callTool("coral_send_message", composedArgs)` + set the latch + throw/return to end the run.

## Recommended execution order

### Pre-condition: decide on a fixture for this milestone

Option (a): **Source-only, use fixture-2 as-is.** The 5 predicates and the Koog reference in `Main.kt` are enough of a contract to implement against. No fresh capture. Fastest path, lowest cost.

Option (b): **Capture a live compliance-demo trace.** Boot compliance-demo's Coral server (separate config at `/Users/bambozlor/Desktop/content-lab/compliance-demo/coral-server/config.toml`), run a sanctions screening end-to-end, save the iter-N artifacts, run-artifact, and optionally Gradle stdout. Gives byte-level evidence for regressions AND a baseline to diff a future pi-mono send run against. Higher cost (Gradle boot + LLM tokens on the compliance side) but pays down twice: once for this milestone, once for any future send-path regression investigation.

Default recommendation: **(a)** unless the first TS implementation attempt fails in an ambiguous way. The fixture-2 source spec is unusually explicit.

### Build order (fixture-gated, one RED test per commit)

For each commit below: RED (lock the predicate as a failing test) → GREEN (minimal impl) → live-check (optional where applicable). This is the same rhythm attempt 2 + iter-N expansion used.

1. **Predicate 1 — tool gate RED test**, then implementation via `beforeToolCall` returning a blocked result with structured reason. Commit targets only this predicate; do not extract state in the same commit.
2. **Predicate 2 — state extraction RED test**, then implementation via `afterToolCall` hook writing to a closure-captured `ScreeningWorkflowState`-equivalent (market-signal-pairwise's molecule doesn't need the full 11-field Koog state; a minimal state for the "has any agentkit tool completed successfully?" predicate is enough on the first pass). Pick a pilot state shape that matches trends' current behavior.
3. **Predicate 3 — runtime-composed send RED test** at the unit level (given a state object satisfying the terminal predicate, the runtime emits a well-formed `coral_send_message` payload; no live run needed for this one). GREEN impl: call `coral.callTool` from the `turn_end` handler when state is ready.
4. **Predicate 4 — idempotency latch RED test**. The handler from commit 3 should double-invoke no-op. Cheapest test: call the handler twice with a state already past the terminal predicate; assert only one call reaches the MCP mock.
5. **Predicate 5 — fallback finalize RED test**. Wire an iteration-ceiling path: if the loop exits (via `agent_end`) without the latch, the fallback fires. Natural place: after `await runAgentLoop(...)` returns, check the latch; if unset, compose + send.
6. **Live milestone validation.** Run the pairwise molecule. Expect `observedAtomResult:true` in the RunArtifact, and a single `coral_send_message` from trends with a structured `atom_result` payload. Compare against option-(b) fixture bytes if captured.

### Scope boundaries for this milestone (say NO to these in-session)

- **Do not** port Koog's full 11-field `ScreeningWorkflowState` — that's sanctions-specific. Design a minimal state object for the market-signal-pairwise molecule; the fixture contract is about *shape*, not exact fields.
- **Do not** implement phase-aware system prompt (`Main.kt:752`) — it's listed as non-required in fixture-2 and doubles the commit count.
- **Do not** implement tool argument sanitization (`Main.kt:532`) or result compaction (`Main.kt:600`). Both are listed as optional in fixture-2.
- **Do not** introduce the atom-state.ts machinery from `archive/pi-mono-attempt-1` yet. Keep the state closure-local to `runAtom` until a second atom (beyond trends) needs to share the shape.
- **Do not** broaden scope to molecule-level workflow DSL. Still explicitly out per `project_deferred_features.md`.

## Specific gotchas to remember

- `runAgentLoop`'s `currentContext = { ...context, messages: [...] }` spread captures `context.tools` AND `context.messages` as references. If predicate 3 or 5 needs to inject a message (e.g. a runtime-generated notification to the transcript), mutate `context.messages` IN PLACE (push), never reassign. Same gotcha as tools; see `feedback_pi_mono_loop_context_reference.md`.
- `afterToolCall` receives the executed result in `context.result`. Mutating the closure-captured state there is safe. Returning an overriding result from `afterToolCall` replaces what the model sees — use this to feed back compacted or rejection results.
- The debug writer reads `agentContext.systemPrompt` and `agentContext.tools`. If you mutate these mid-run, artifacts reflect post-mutation state. That's fine for tools (desired) but if you plan to rewrite systemPrompt per iteration (phase-aware prompt, if it ever comes in), expect the artifact to show the rewrite — don't trust it as evidence of iter-0 behavior retroactively.

## Validation checklist for this milestone

A reviewer should be able to answer YES to every one of these before merging:

- [ ] `npm test` green, including at least one new test per fixture-2 predicate (5 predicates ≥ 5 new tests; ideally one or two per predicate for edge cases).
- [ ] `npx tsc --noEmit` clean.
- [ ] Live pairwise session yields exactly one `sender:trends` message with a structured `atom_result` envelope (not model-composed natural language).
- [ ] That single send is issued by the runtime — verifiable by a log line in the debug artifact, or by the fact that the model never saw `coral_send_message` return success (only rejections).
- [ ] `observedAtomResult:true` in the RunArtifact.
- [ ] No duplicate sends under any iteration count (test via a forced long iteration run).
- [ ] Memory updates: status note + (if fixture-2 got a live capture) updated `reference_compliance_demo.md`.

## Branch and tag hygiene

- Create a worktree `.worktrees/pi-mono-runtime-finalize` off master. `.worktrees/` is already gitignored.
- Branch name: `pi-mono-runtime-finalize` (consistent with prior milestone naming).
- On merge, `--no-ff`, tag `pi-mono-runtime-finalize-green`, worktree removed, branch deleted (tag preserves commits). Same pattern as prior two milestones.
- Coral server config (`coral-server/config.toml`) should stay pointed at master's `agents/` during implementation — flip to the worktree's paths only when running live validation, then flip back on merge. The prior two sessions both forgot this once; setting a reminder here to avoid it.

## If things go wrong

- If the first fixture-2 attempt regresses receive path (e.g. a `beforeToolCall` hook accidentally blocks a legit agentkit call), the 13 existing tests should catch it before any live run. If they don't, add a RED test that would have caught it and only then proceed.
- If the model ignores the rejection results from the tool gate and keeps trying to `coral_send_message` every turn, that's a prompt-engineering problem, not a runtime-correctness problem. The runtime is doing its job (blocking + feeding back a reason). Consider a phase-aware prompt hint as a secondary fix — but only after the 5 predicates are in place.
- If fixture-2 itself turns out to need revision (e.g. a predicate can't be cleanly satisfied given pi-mono's hook semantics), append a new fixture version under `docs/fixtures/coral-wire-traces/03-…` rather than editing `02-…` in place. Fixtures are append-only per the root fixtures README.

## Pointers

- Fixture-2 spec: `docs/fixtures/coral-wire-traces/02-compliance-demo-runtime-spec/README.md`
- Koog reference code: `docs/fixtures/coral-wire-traces/02-compliance-demo-runtime-spec/Main.kt`
- Current runtime: `src/runtime/pi-runtime.ts`
- Current tests: `src/runtime/pi-runtime.test.ts`, `src/runtime/prompt.test.ts`
- Pi-mono core hooks: `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:77–200` (`AgentLoopConfig`)
- Archive of attempt-1 `makeToolGate` / state helpers (reference-only, do not cherry-pick without a fixture): `archive/pi-mono-attempt-1` (tag)

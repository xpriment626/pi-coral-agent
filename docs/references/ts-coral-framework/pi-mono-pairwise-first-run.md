# pi-mono pairwise: first live run (H2 milestone)

**Date:** 2026-04-18
**Branch:** `pairwise-pi-mono` (archived as tag `archive/pi-mono-attempt-1`)
**Commit at run time:** `c2ccf53c703c97436d443f1879d771532eb34ea1`
**Molecule:** `market-signal-pairwise`
**Coral session IDs:**
- First run (against wrong worktree, see "Infra side-issue"): `6b5abbb8-2596-4596-8159-f1c342edd673`
- Second run (against pi-mono atoms): `eb9d0b48-4c37-4db2-bd4e-e120e0d83f71`

**Classification: RED.** Both banned failure-mode tags (`message_non_execution`, `handoff_missing`) are present. The full RunArtifact failure_modes array (identical for both runs) is:

```
["tool_non_execution", "message_non_execution", "handoff_missing"]
```

## Per-atom evidence (pi-mono run, session `eb9d0b48-...`)

### `trends` (market-trends)

- **Tool calls:** 37 — every single one is `coral_wait_for_message({ currentUnixTime: 1776485885062, maxWaitMs: 5000 })`.
- **Result for every call:** `{"status":"Timeout reached"}`.
- **`coral_send_message` attempted:** **No.** The runtime-managed finalize path never fires because `state.phase` never leaves `awaiting_request` — the seed atom_request never reaches the model.
- **Terminal state phase:** `awaiting_request` (state machine never advances; `request: null`, `collectedTokens: []`, `fetchCalls: 0`).
- **Subprocess exit:** None — the trends atom is still in its `coral_wait_for_message` loop when the orchestrator script finishes its 2-minute polling window and exits. No `atom-budget-exhausted` style termination (the pi-mono `startAtom` template has no max-iteration ceiling; it runs `await agent.waitForIdle()` indefinitely).

### `info` (token-info)

- **Tool calls:** 37 — every single one is `coral_wait_for_message({ currentUnixTime: 1776485885063, maxWaitMs: 5000 })`.
- **Result for every call:** `{"status":"Timeout reached"}`.
- **`coral_send_message` attempted:** **No.** Info also never sees an inbound message, never advances past `awaiting_request`.
- **Terminal state phase:** `awaiting_request`.
- **Subprocess exit:** None (same reason as trends).

## The mechanism — message replay window cuts off the seed

The Coral Server logs show, repeatedly, for both atoms:

> `attempting to wait for any message from any agent, replaying messages after 2026-04-18T04:18:05.062Z`
> `no messages to replay, waiting for new messages for 5000ms...`

But the puppet sent the seed at:

> `2026-04-18 12:18:03.488 ... [agent=puppet] sent message ... id=55fb7fbc-... mentioning: trends`

That is `2026-04-18T04:18:03.488Z` UTC — **1.574 seconds before** the replay cutoff the trends atom is using. The seed message therefore never enters the `replay` window for any subsequent `coral_wait_for_message` call.

The cutoff `1776485885062` (= `2026-04-18T04:18:05.062Z`) is the value the model passed as `currentUnixTime` on its FIRST `coral_wait_for_message` call (timestamp captured by the Coral MCP `coral_wait_for_message` tool when the atom first connected). Subsequent iterations re-send the **same** `currentUnixTime` — see `iter-0001.json` and `iter-0024.json` for trends, both contain `"currentUnixTime": 1776485885062`. So the replay window never moves backward to pick up the seed, and never moves forward to pick up anything else (because there are no later messages either: trends never replies, and puppet only sent the one seed).

Quote from `agents/market-trends/.coral-debug/trends/eb9d0b48-.../iter-0001.json`:

```json
{
  "type": "toolCall",
  "name": "coral_wait_for_message",
  "arguments": { "currentUnixTime": 1776485885062, "maxWaitMs": 5000 }
}
...
{ "toolName": "coral_wait_for_message",
  "content": [{ "type": "text", "text": "{\"status\":\"Timeout reached\"}" }] }
```

Quote from a later iter (37th call, identical args — see `agents/market-trends/.coral-debug/trends/eb9d0b48-.../iter-0024.json` and onward):

```json
{ "name": "coral_wait_for_message",
  "arguments": { "currentUnixTime": 1776485885062, "maxWaitMs": 5000 } }
```

Same pattern for `info`: every iteration uses `"currentUnixTime": 1776485885063`.

Coral Server log (representative lines), session `eb9d0b48-...`:

```
12:18:03.488 [agent=puppet]  sent message ... mentioning: trends   (the seed)
12:18:05.029 [agent=trends]  sse connection established
12:18:05.029 [agent=info]    sse connection established
12:18:08.354 [agent=trends]  attempting to wait for any message from any agent,
                              replaying messages after 2026-04-18T04:18:05.062Z
12:18:08.354 [agent=trends]  no messages to replay, waiting for new messages for 5000ms...
... [repeats every ~8s for both atoms until script exits] ...
```

## Initial root-cause hypothesis (1 paragraph, no fix)

The pi-mono `startAtom` template surfaces the raw Coral MCP `coral_wait_for_message` tool to the model with no wrapper, and the model picks `currentUnixTime` itself — naturally choosing "now" on the first call and then re-sending that same value for every subsequent call. The Coral Server interprets that arg as the **lower bound of the replay window**, so any message published before the atom finished its MCP handshake (in this case: the puppet's seed, sent ~1.5s before the trends/info SSE connections were established) is permanently invisible. The H2 design — runtime-managed `coral_send_message` that fires when state hits `ready_to_finalize` — is never reached because state never advances past `awaiting_request`. This is an upstream atom-input failure (the agent never sees the seed), not a bug in the state machine, the gate, the harvest extractor, or the runtime finalizer.

## What worked (Green-ish surface evidence)

- Coral Server starts cleanly, accepts the `compileMoleculeToSession` POST, creates the session + thread, registers `puppet` / `trends` / `info` participants.
- Both pi-mono atom subprocesses launch via `npx --yes tsx index.ts`, complete the inlined `SolanaAgentKit` construction (no ESM `createRequire` failures), and successfully connect to Coral over MCP/SSE — log lines `{"event":"connected","atom":"market-trends",...}` and `{"event":"connected","atom":"token-info",...}` appear within ~3s of session creation.
- The puppet successfully posts the seed `atom_request` JSON envelope into the thread with the correct `mentions: [trends]`.
- The Coral MCP tool list (`coral_wait_for_message` etc.) is wired into the Agent's tool surface — the model picks it on iteration 1 and every subsequent iteration with valid arguments. The OpenAI Responses API call goes through cleanly (no auth or schema errors), `gpt-4o-mini` returns properly formatted tool calls, and `pi-agent-core` dispatches them to the MCP transport without fault.
- The pi-mono debug writer (`attachDebugWriter`) writes `iter-NNNN.json` per `turn_end` correctly into `agents/<name>/.coral-debug/<session>/`. Secret redaction runs (no `MODEL_API_KEY` value appears in artifacts). 37 iters per atom were captured.
- The state machine + tool gate (`makeToolGate(...)`) does not throw or crash — it just never receives an `atom_request` to react to. Phase remains `awaiting_request` for the entire run, which is the correct gate behavior given the empty input.
- Per-atom state machines are operating per-atom (no cross-atom orchestration leakage). Both atoms fail in the same way independently, which matches the design's "atom owns its own loop" thesis.

## What broke (Red surface)

- `coral_wait_for_message` semantic: the model-chosen `currentUnixTime` cuts off the seed message. No atom ever advances past `awaiting_request`.
- Therefore: zero `coral_send_message` calls (model-driven OR runtime-managed) by either atom.
- Therefore: `info`'s `coral_wait_for_message` for the trends handoff also never resolves with anything (it's already in the same broken pattern; no handoff would have arrived even if the cutoff bug were fixed only on `info`).
- RunArtifact `failure_modes` includes both H2-banned tags: `message_non_execution`, `handoff_missing` (and additionally `tool_non_execution` because no `agentkit_*` was invoked).

## Infra side-issue surfaced and resolved during the run

The first attempted run (session `6b5abbb8-...`) routed to the wrong worktree. `coral-server/config.toml` had its `[registry].local_agents` array pointing at `.worktrees/atoms-runtime/agents/{market-trends,token-info}` (the OLD Vercel-SDK gen). I updated the two relevant entries to point at `.worktrees/pairwise-pi-mono/agents/{market-trends,token-info}` and restarted the server, which is what produced session `eb9d0b48-...` (the run analyzed above). The other three atom registrations (`market-price`, `oracle-price`, `wallet-assets`) are unchanged — they are out of scope for the pairwise milestone.

## Files captured (in archived branch `archive/pi-mono-attempt-1`)

- `.coral-runs/market-signal-pairwise-eb9d0b48-4c37-4db2-bd4e-e120e0d83f71.json` (RunArtifact, pi-mono session)
- `.coral-runs/market-signal-pairwise-6b5abbb8-2596-4596-8159-f1c342edd673.json` (RunArtifact, wrong-worktree session — kept for completeness)
- `agents/market-trends/.coral-debug/trends/eb9d0b48-.../iter-0001.json` … `iter-0037.json`
- `agents/token-info/.coral-debug/info/eb9d0b48-.../iter-0001.json` … `iter-0037.json`

## Post-mortem framing (added 2026-04-18, after debrief)

The narrow `coral_wait_for_message` arg bug is real but is **not** the primary lesson. The execution-level lessons:

1. **Receive path was already green in Gen 2 (atoms-runtime) and was destroyed by the rewrite without a regression test.** Gen 2's failure was *send*; Gen 3 broke *receive*. We rebuilt code that was already working instead of preserving it and only replacing the broken slice.
2. **No fixture for "atom successfully receives a mention" existed before Task 16.** The first time the new `coral_wait_for_message` wiring ran was the H2 milestone itself — no integration smoke test gated any prior task.
3. **Plan-driven decomposition let each subagent succeed at its slice while the system regressed.** Subagents had no signal that "atoms-runtime received correctly" was load-bearing context they had to preserve.

Next attempt does not start with a plan or a runtime rewrite. It starts with capturing wire traces from two known-good sources (atoms-runtime Gen 2; compliance-demo Kotlin agents) and treating those traces as the executable spec any pi-mono atom must replay. See `docs/fixtures/coral-wire-traces/README.md` for the fixture-capture work.

# Coral Wire Trace Fixtures

**Purpose:** Capture executable wire traces from known-good Coral sessions. Any future TS Coral runtime implementation must replay these traces successfully before it is allowed to proceed past the receive-path checkpoint. The fixture is the spec; no plan document overrides it.

This directory exists because the pi-mono port attempt 1 (2026-04-18) regressed the receive path that Gen 2 (`atoms-runtime`) had working. There was no fixture to catch the regression. Fixing that gap is a precondition for any further runtime work. Background: [`docs/decomposition/ts-coral-framework/pi-mono-pairwise-first-run.md`](../../decomposition/ts-coral-framework/pi-mono-pairwise-first-run.md).

## Sources

### 1. atoms-runtime (Gen 2 TS) — receive path green

- **Worktree:** `.worktrees/atoms-runtime` (branch `atoms-runtime`, commit `ea3df49`)
- **Coral Server config:** the one in this repo (`coral-server/config.toml`) — currently points at `.worktrees/atoms-runtime/agents/{market-trends,token-info}` for the trends/info atoms.
- **What's green here:** atoms launch via `npx --yes tsx index.ts`, complete MCP/SSE handshake, **successfully receive the puppet seed `atom_request`**, and execute Agent Kit calls in response (46 in the original 2026-04-17 session).
- **What's red here (out of scope for fixture-1):** atoms never call `coral_send_message`. Capture stops once we've confirmed receive — send is the next milestone after fixture-1, not part of it.
- **Reference session:** `cd34fd31-7067-473c-b799-ab68e1138e41` (RunArtifact in worktree's `.coral-runs/`).

### 2. compliance-demo (Kotlin) — runtime spec source

- **Repo:** `/Users/bambozlor/Desktop/content-lab/compliance-demo/`
- **Canonical source:** `coral-sanctions-agent/src/main/kotlin/ai/coralprotocol/coral/koog/fullexample/Main.kt` (1208 lines — copied verbatim into fixture-2).
- **Why source-only (decided 2026-04-18):** fixture-1 already proves wire-level Coral protocol behavior in a TS context. The send mechanism in `Main.kt` is unambiguous as a runtime contract; a wire trace would only confirm "the code does what its name says," which is low-value evidence. Save the cost of booting Gradle + a live screening + LLM tokens for when (if) a future pi-mono attempt fails specifically on the send path and needs a wire-level diff to debug. Until then, YAGNI. See `02-compliance-demo-runtime-spec/README.md` for full reasoning.
- **Live capture deferred, not abandoned:** if needed later, boot compliance-demo's Coral Server (its own config at `compliance-demo/coral-server/config.toml`, won't conflict with the solana-aat-library config), run a sanctions screening end-to-end, capture the Coral Server logs + agent stdout. Don't modify compliance-demo when capturing — it's the known-good reference.

## Capture format (decided 2026-04-18, after fixture-1)

The fixture-1 capture surfaced a cleaner format than originally planned:

- **Per-atom debug iter-N.json** files (the format the Gen 2 `attachDebugWriter` produces) are sufficient as the primary evidence. They contain the assembled system prompt, the assembled state resource (which includes thread + message history at iter time), the model's tool calls, and the tool results. This captures both sides of the model↔runtime exchange in one file per iteration.
- **RunArtifact** is the aggregate view (per-agent tool sequences, observed messages, failure modes) and is captured verbatim.
- **Puppet seed** is extracted as its own clean envelope file for clarity, even though it's also embedded in the iter-0 state resource and the RunArtifact's `task.seed`.
- **Coral Server logs** are NOT captured — they're Gradle stdout, not file-rotated, and the iter-N files already show what the runtime saw from the server's responses. If a future fixture needs server-side logs, the capture script needs to tee Gradle stdout to a file at run time.

Granularity is "iter boundaries," not "every MCP frame." Time is captured verbatim (the Unix timestamps in state resources are part of the evidence). LLM side and Coral side are both in the iter file, so no mocking-strategy split is needed at the fixture level.

## Files in this directory

```
docs/fixtures/coral-wire-traces/
├── README.md                                      (this file)
├── 01-atoms-runtime-receive-seed/                 ✅ captured 2026-04-18
│   ├── README.md                                  (what fixture-1 asserts + how to use)
│   ├── puppet-seed.json                           (clean atom_request envelope)
│   ├── trends-iter-0.json                         (addressed atom — receives via state resource, acts immediately)
│   ├── info-iter-0.json                           (peer atom — sees same state, correctly waits)
│   └── runartifact.json                           (aggregate session view)
└── 02-compliance-demo-runtime-spec/               ✅ captured 2026-04-18 (source-only, intentional)
    ├── README.md                                  (Koog→pi-mono mapping for the 3 send-path primitives + the 5-predicate contract)
    └── Main.kt                                    (verbatim copy of canonical Koog atom, 1208 lines)
```

## Headline finding from fixture-1

**The Gen 2 receive mechanism is state-resource injection into the system prompt, NOT the `coral_wait_for_message` MCP tool.** Pi-mono attempt 1 broke this by relying on the wait tool. Any future runtime must expand `<resource uri="coral://state">…</resource>` in the system prompt with the agent's current thread + message state before the first model call. See [`01-atoms-runtime-receive-seed/README.md`](01-atoms-runtime-receive-seed/README.md) for the contract any future runtime must satisfy.

## Non-negotiable rules

1. **No new runtime code lands before fixture-1 exists.** The point of this directory is to make the regression bar executable. Skipping the fixture and "just trying pi-mono again with the cutoff bug fixed" is exactly the anti-pattern this directory exists to prevent.
2. **Fixtures are append-only.** If a fixture turns out to be wrong, write a new fixture and supersede the old one in this README — don't edit the captured frames in place. We need to be able to compare what was vs what is.
3. **Preserve the trace sources.** Don't touch `.worktrees/atoms-runtime` or `compliance-demo` once captures begin. If either stops working, we lose the source.

## Status

- 2026-04-18 (morning): directory created; sources identified; format TBD.
- 2026-04-18 (afternoon): fixture-1 captured from existing atoms-runtime artifacts (no fresh run needed). Format decided. Headline finding above.
- 2026-04-18 (later): fixture-2 captured as source-only spec (`Main.kt` + Koog→pi-mono mapping + 5-predicate contract). Live wire capture deferred per YAGNI rationale in fixture-2 README.
- **Both fixtures are now in place. Next runtime work begins gated on these fixtures.**

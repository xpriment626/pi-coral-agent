# Tier 1 Validation

**Date:** 2026-04-19
**Session:** 949a4a5d-3584-4120-9e3b-6c904d613d44
**Target:** pi-coral-agent/0.0.1 (template root)

## Outcome

- [x] Atom connected to MCP via injected CORAL_CONNECTION_URL
- [x] Received puppet seed in thread (`mentions: ["tpl"]`)
- [x] All 8 `coral_*` tools visible at iter 1 (`coral_add_participant`, `coral_close_thread`, `coral_create_thread`, `coral_remove_participant`, `coral_send_message`, `coral_wait_for_agent`, `coral_wait_for_mention`, `coral_wait_for_message`)
- [x] systemPrompt delivered to model with both resources expanded (length 4086; contains BASE+MESSAGING+MENTIONS+WAITING instruction snippets + agent state JSON)
- [x] Debug artifact written per turn_end (4 iterations captured) with OpenAI key redacted (grep for `sk-` returned 0 matches across all 4 artifacts)
- [x] Template replied `pong` on the thread (server log: `sent message "pong" (id=15b5cedd-...) into thread ff078b78-...`)

## Server log excerpt (tier1-validation / 949a4a5d-...)

```
17:57:01  tpl: attempting to wait for a message that matches filters [mentions: tpl]
17:57:01  tpl: communication status thinking -> waiting
17:57:06  pup: created thread "tier1-validation" with ID ff078b78-..., participants: tpl
17:57:09  tpl: attempting to wait for a message that matches filters [mentions: tpl]
17:57:11  pup: sent message "ping" (id=81ff1afb-...) mentioning: tpl
17:57:11  tpl: found matching message: 81ff1afb-... in 2.17s
17:57:13  tpl: sent message "pong" (id=15b5cedd-...)
17:57:14  tpl: exited with code 0
```

End-to-end latency: puppet seed sent at 17:57:11, pong delivered at 17:57:13 — 2 seconds.

## Success criterion (from design.md)

> A dummy atom can connect via MCP, receive a puppet-seeded message, produce
> at least one LLM turn with coral_* tools + atom-specific tools visible, and
> write a readable debug artifact per turn_end with secrets redacted.

Met, using the template root directly (no separate dummy atom needed). **Tier 1 DONE.**

## Notable observations

- Model chose `coral_wait_for_mention` on its own, pre-seed. The 5s wait timed out, it briefly flipped to thinking, then re-issued the wait tool. When the puppet seed arrived 2s into the second wait, it matched and the model proceeded to `coral_send_message`. No gating needed — the model's own reasoning over `coral://instruction` handles the wait-then-act pattern.
- Loop exit via natural tool-call completion + MCP close. No outer loop, no session-close tool, no timer. Runtime exits cleanly when the model stops calling tools.

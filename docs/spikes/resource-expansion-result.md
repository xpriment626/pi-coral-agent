# Spike: `<resource>` tag expansion

**Date:** 2026-04-19
**Session:** 8f1638c5-7b27-4710-ac33-0878de78a1c5
**Artifact:** `spikes/resource-expansion/.spike-artifacts/8f1638c5-7b27-4710-ac33-0878de78a1c5.json`

## Finding

The `SYSTEM_PROMPT` env var reaches the agent process verbatim, including literal tags in both supported forms:

```
<resource>coral://instruction</resource>
<resource uri="coral://state"/>
```

`CORAL_PROMPT_SYSTEM` was `null`. No alternate env var surfaces a pre-expanded prompt. The docs' phrase *"Server replaces `<resource>` tags in agent prompts automatically"* refers to something other than env-delivered prompts — possibly Prototype runtime or future API — but for executable agents via `[runtimes.executable]`, expansion is the agent's job.

Tools observed at connect time:
- `coral_create_thread`, `coral_close_thread`
- `coral_add_participant`, `coral_remove_participant`
- `coral_send_message`
- `coral_wait_for_message`, `coral_wait_for_mention`, `coral_wait_for_agent`

All 8 `coral_*` tools present from a single `listTools()` call. Confirms: **no server-side tool gating; expose all from turn 1.**

`coral://instruction` body includes BASE + MESSAGING + MENTIONS + WAITING snippets, consistent with the server's per-toolset composition documented in `features/resources.md`.

## Decision

**KEEP_THIN_BUILDSYSTEMPROMPT** — retain a simplified `buildSystemPrompt` helper in the template that takes `(systemPrompt, resourceMap)` and substitutes both documented tag forms. Drop the Koog byte-equality fidelity goal; the helper exists to keep `<resource>` substitution in one place.

## Implications for strip

- Task 5 (pi-runtime.ts): `resolveSystemPrompt` keeps the resource-fetching + substitution path; prompt is still built client-side.
- Task 6 (prompt.ts): take branch A (KEEP). Simplified `buildSystemPrompt` that handles both `<resource>...</resource>` and `<resource uri="..."/>` forms stays.
- Task 8 (src/index.ts): includes `export { buildSystemPrompt }` and `export type { BuildSystemPromptInput }`.

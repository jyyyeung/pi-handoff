# Vendored from upstream MIT sources

- `@tifan/pi-handoff` 2.2.2 — https://github.com/tifandotme/pi-extensions
  (packages/pi-handoff), © Tifan Dwi Avianto, MIT.
- `@tifan/pi-rename` 0.6.0 — same repository (packages/pi-rename), © Tifan
  Dwi Avianto, MIT. Only the naming core (`src/rename/`: naming, models,
  sanitize, language) is vendored; the pi-rename extension itself is not.

## Local changes (this fork)

1. `src/rename/naming.ts`: `getUserMessageContext` drops extension-injected
   synthetic user messages (`New intercom message above.`,
   `Continue from this handoff:`, `/__pi-handoff-session`,
   `Inspect subagent updates above.`); `fallbackRenameName` uses the FIRST
   real user message instead of the last.
2. `src/index.ts`: handoff child naming via `resolveHandoffBaseName` —
   explicit focus > parent session name (prefix stripped) > rename model >
   first-message fallback.
3. `src/session-query.ts`: `session_query` model resolves from the
   configured rename model (`~/.pi/agent/extensions/pi-rename.json`), then
   the session model.
4. `src/index.ts`: verified prompt delivery (herdr --wait + status
   cross-check + 1 retry), reason-tagged handoffs — budget reason
   auto-closes the parent tab after 3s (opt-out `PI_HANDOFF_KEEP_TAB=1`),
   voluntary reason keeps it marked `[handed-off]` — and parent-tab
   retirement.
5. `src/index.ts`: in-flight subagent-run adoption section in budget
   handoff docs, reading pi-subagents on-disk run state
   (`PI_SUBAGENTS_TEMP_ROOT` or `~/…/pi-subagents-uid-*/async-subagent-runs
   /<runId>/status.json`): one line per still-active (`queued`/`running`)
   run with a `bg_wait` recovery line, `None at handoff time.` when none,
   and an unreadable-state hint pointing at the session-side
   `subagent-artifacts` directory when the runs root cannot be listed.

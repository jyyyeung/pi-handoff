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
6. `src/index.ts`: extended the `HANDOFF_SYSTEM_PROMPT` requirements so
   generated handoff docs carry a verify-first section of exact one-line
   commands near the top, a "Governing decisions" section listing every
   binding owner decision with its source and date (or `None recorded.`),
   inline verification evidence (the exact command and observed result)
   for every checkable factual claim with an explicit `UNVERIFIED` marker
   when a claim could not be verified, and a compactness rule (commands and
   one-line facts only) for successor token economy.
7. `src/index.ts`: a missing `handoff` skill is no longer fatal. The
   extension used to refuse to run unless a skill named exactly `handoff` was
   discoverable; it now falls back to an exported built-in policy
   (`BUILT_IN_HANDOFF_SKILL`) and warns once, so the package works straight
   after `pi install`.
8. `src/index.ts`: `getHerdrWorkspaceId()` returns `undefined` instead of
   throwing `Herdr workspace context is unavailable` when `HERDR_ENV=1` but
   `HERDR_WORKSPACE_ID` is unset — the caller then takes the in-process
   `ctx.newSession` path instead of failing the whole handoff.
9. `src/backend.ts` (new, no imports): `resolveHandoffBackend()` reads
   `PI_HANDOFF_BACKEND` so the successor-session backend can be pinned to the
   dependency-free in-process path (`ctx.newSession`) even on a machine where the
   external tab manager is available. Default `auto` keeps the tab backend only
   when a workspace is detected; a missing workspace falls back with a warning
   instead of failing the handoff.

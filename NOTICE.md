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
   the session model — upstream hardcoded unauthenticated openai-codex.
4. `resolveHandoffBaseName` exported for tests.

Upstream patches for (1)/(2) live in `~/.pi/agent/patches/` as reference
diffs; this package is the canonical copy.

# Changelog

All notable changes to this package. Versions before 0.1.0 in this repository
were the upstream `@tifan/pi-handoff` 2.2.2 tree; the local fork restarts its
version line at 0.1.0 because it publishes under a different name
(`@jyyyeung/pi-handoff`) and diverges from upstream.

## 0.1.1

### Added

- `PI_HANDOFF_BACKEND` (`auto` | `in-process` | `tab`) selects how the successor
  session starts. `in-process` is dependency-free and uses `ctx.newSession`;
  `tab` uses the external tab manager; `auto` (the default) picks `tab` only when
  a workspace is actually detected. Asking for `tab` without one warns and falls
  back instead of failing.

### Changed

- README leads with the actual trigger (`-handoff <focus>`) and a quick
  start; prerequisites are split into required vs tab-backend-only.
- Package description no longer advertises the tab backend first.
- README no longer reads as a tab-manager-only package: the backend table comes
  first, features are split into "works everywhere" and "added by the tab
  backend", and the tab manager is listed as optional in the prerequisites.

## 0.1.0

Published as `@jyyyeung/pi-handoff`. Functional behaviour is the 2.5.1 tree
from this repository's history, plus the release-hygiene fixes below.

### Fixed

- A missing `handoff` skill is no longer fatal. The extension used to refuse to
  run unless a skill named exactly `handoff` was discoverable; it now falls back
  to an exported built-in policy (`BUILT_IN_HANDOFF_SKILL`) and warns once, so
  the package works straight after `pi install`.
- `HERDR_ENV=1` without `HERDR_WORKSPACE_ID` no longer throws `Herdr workspace
  context is unavailable`; the caller takes the in-process `ctx.newSession`
  path instead of failing the whole handoff.

### Added

- `test/naming-core.test.ts` — smoke tests over the vendored naming core
  (secret redaction, name sanitising, language parsing) so a re-vendor from
  upstream cannot silently change session names.
- `tsconfig.json` + `typecheck` script, and a CI workflow running tests and
  typecheck.
- README prerequisites table stating exactly which features need `herdr`.

### Changed

- README documents `pi install` instead of hand-editing
  `~/.pi/agent/settings.json`.

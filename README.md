# pi-handoff

Reliable session handoffs for the pi coding agent. When a session ends, pi-handoff delivers a verified successor prompt into a fresh session — no lost context, no dangling tabs, no half-adopted subagent runs. Community fork of @tifan/pi-handoff.

## Features

- **Verified prompt delivery** — handoff prompts are sent through `herdr --wait` and cross-checked via status polling, with one automatic retry if delivery is not confirmed. *(herdr only; see prerequisites)*
- **Parent tab retirement** — the originating parent tab is marked `[handed-off]` so you can see at a glance that it has been superseded. *(herdr only)*
- **Budget-aware auto-close** — when the handoff reason is budget exhaustion, the parent tab auto-closes after 3 seconds. Opt out with `PI_HANDOFF_KEEP_TAB=1`. Voluntary handoffs keep the parent tab open. *(herdr only)*
- **Smart child naming** — naming core from pi-rename: explicit focus > parent session name (prefix stripped) > rename model > first real user message fallback, with synthetic-message filtering.
- **Configurable session_query model** — the `session_query` tool resolves its model from the configured rename model, then the session model.
- **Verify-first checklist** — generated handoff docs open with a short list of exact one-line commands the successor runs before trusting the document's state claims (repo status, task board, CI, live sessions).
- **Governing decisions in generated docs** — every binding owner decision that constrains the next session is listed with its source and date, including decisions made in sibling sessions, or marked `None recorded.`

## Prerequisites

| Requirement | Needed for | If missing |
|---|---|---|
| pi ≥ 1.3 | everything | — |
| Node ≥ 20 | everything | — |
| A model with tool use | generating the handoff document | `/handoff` reports "No model selected." |
| `herdr` binary + `HERDR_ENV=1` + `HERDR_WORKSPACE_ID` | verified delivery, parent-tab retirement, budget auto-close (the "open a new tab" path) | the handoff still works: it opens an **in-process new session** via `ctx.newSession` instead |
| a skill named `handoff` | customizing the document policy | the **built-in handoff policy** is used and a warning is shown |

The package is usable on a plain pi install: nothing below the herdr row is required to get a handoff document plus a successor session. The herdr row only upgrades *how* the successor starts (a real terminal tab with verified prompt delivery, rather than an in-process session).

## Install

```bash
pi install ./pi-handoff      # local checkout
pi install npm:pi-handoff    # published package
```

Then restart pi (or `/reload`). If you prefer hand-editing, add the package
path to the `packages` list in `~/.pi/agent/settings.json` — but `pi install`
is the supported path.

Optionally install a `handoff` skill (any pi skill whose name is exactly
`handoff`) to replace the built-in document policy with your own.

## Credits

Forked from [@tifan/pi-handoff](https://github.com/tifandotme/pi-extensions) 2.2.2 (packages/pi-handoff), © Tifan Dwi Avianto, MIT. Child-naming core from [@tifan/pi-rename](https://github.com/tifandotme/pi-extensions) 0.6.0 (packages/pi-rename), © Tifan Dwi Avianto, MIT. `NOTICE.md` lists every local change this fork carries; upstream has no obligation to accept them, and this package does not track upstream automatically.

## License

MIT

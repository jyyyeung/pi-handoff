# pi-handoff

Reliable session handoffs for the pi coding agent. When a session ends, pi-handoff delivers a verified successor prompt into a fresh session — no lost context, no dangling tabs, no half-adopted subagent runs. Community fork of @tifan/pi-handoff.

## Features

- **Verified prompt delivery** — handoff prompts are sent through `herdr --wait` and cross-checked via status polling, with one automatic retry if delivery is not confirmed.
- **Parent tab retirement** — the originating parent tab is marked `[handed-off]` so you can see at a glance that it has been superseded.
- **Budget-aware auto-close** — when the handoff reason is budget exhaustion, the parent tab auto-closes after 3 seconds. Opt out with `PI_HANDOFF_KEEP_TAB=1`. Voluntary handoffs keep the parent tab open.
- **Smart child naming** — naming core from pi-rename: explicit focus > parent session name (prefix stripped) > rename model > first real user message fallback, with synthetic-message filtering.
- **Configurable session_query model** — the `session_query` tool resolves its model from the configured rename model, then the session model.
- **Verify-first checklist** — generated handoff docs open with a short list of exact one-line commands the successor runs before trusting the document's state claims (repo status, task board, CI, live sessions).
- **Governing decisions in generated docs** — every binding owner decision that constrains the next session is listed with its source and date, including decisions made in sibling sessions, or marked `None recorded.`

## Install

Register the package directory in `~/.pi/agent/settings.json` under the `packages` list:

```json
{
  "packages": [
    "/path/to/pi-handoff"
  ]
}
```

Restart pi to load the extension. Requires Node >= 20.

## Credits

Forked from [@tifan/pi-handoff](https://github.com/tifandotme/pi-extensions) 2.2.2 (packages/pi-handoff), © Tifan Dwi Avianto, MIT. Child-naming core from [@tifan/pi-rename](https://github.com/tifandotme/pi-extensions) 0.6.0 (packages/pi-rename), © Tifan Dwi Avianto, MIT.

## License

MIT

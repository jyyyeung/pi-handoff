/**
 * Which successor-session backend a handoff uses.
 *
 * `in-process` is the dependency-free default: the handoff document is written
 * and a new pi session is opened with `ctx.newSession`. `tab` opens a real
 * terminal tab through an external tab manager (verified prompt delivery,
 * parent-tab retirement). `auto` prefers `tab` only when that manager is
 * actually detected, so a plain pi install never trips over a missing binary.
 *
 * Kept in its own module with no imports so it stays unit-testable: the
 * extension entry point pulls in pi runtime packages and cannot be imported
 * from `node --test`.
 */
export type HandoffBackend = "auto" | "tab" | "in-process"

const IN_PROCESS_ALIASES = ["in-process", "inprocess", "session", "new-session"]
const TAB_ALIASES = ["tab", "herdr", "terminal"]

export function resolveHandoffBackend(
  env: NodeJS.ProcessEnv = process.env,
): HandoffBackend {
  const raw = env["PI_HANDOFF_BACKEND"]?.trim().toLowerCase()
  if (!raw) return "auto"
  if (IN_PROCESS_ALIASES.includes(raw)) return "in-process"
  if (TAB_ALIASES.includes(raw)) return "tab"
  return "auto"
}

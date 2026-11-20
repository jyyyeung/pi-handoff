/**
 * One-line plain seed for the `herdr agent start` argv. herdr rejects any
 * agent argument containing a real newline (`invalid_agent_argument`), so
 * argv seeds must be single-line — see SEEDARG D5fix. The multiline variant
 * (`buildNewSessionPrompt`) stays for the in-process `ctx.newSession` path,
 * where the seed goes through `sendUserMessage`, not a shell argv.
 */
export function buildPlainLaunchSeed(handoffPath: string): string {
  return `Continue from this handoff: ${handoffPath} — read it, load any suggested skills, then continue the work.`
}

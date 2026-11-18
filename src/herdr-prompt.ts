import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export type HerdrCommandResult = {
  code: number
  stdout: string
  stderr: string
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function getCommandError(stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || "unknown error"
}

const ENGAGEMENT_PROBE_INTERVAL_MS = 2_000
const ENGAGEMENT_PROBE_COUNT = 6

export function isEngagedHerdrStatus(status: unknown): boolean {
  return status === "working" || status === "blocked" || status === "done"
}

export async function herdrAgentEngaged(
  pi: ExtensionAPI,
  agentName: string,
): Promise<boolean> {
  const got = await pi.exec("herdr", ["agent", "get", agentName], {
    timeout: 5_000,
  })
  if (got.code !== 0) return false
  try {
    const status = (
      JSON.parse(got.stdout) as {
        result?: { agent?: { agent_status?: unknown } }
      }
    )?.result?.agent?.agent_status
    return isEngagedHerdrStatus(status)
  } catch {
    return false
  }
}

/**
 * Polls `engaged` until it reports true or the probes run out. Engagement is
 * advisory only: herdr reports `agent_prompt_stalled` when a slow-booting
 * successor misses the 5s working transition even though the submission was
 * already delivered, so engagement must never trigger a re-send.
 */
export async function waitForEngagement(
  engaged: () => Promise<boolean>,
  probeCount = ENGAGEMENT_PROBE_COUNT,
  intervalMs = ENGAGEMENT_PROBE_INTERVAL_MS,
): Promise<boolean> {
  for (let probe = 0; probe < probeCount; probe += 1) {
    if (await engaged()) return true
    await delay(intervalMs)
  }
  return false
}

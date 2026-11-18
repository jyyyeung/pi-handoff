import {
  WORK_ID_RE,
  WorkIdStore,
  type SessionInfo,
  type WorkIdEntry,
} from "pi-workid/src/store.ts"

/**
 * Work-ID identity for handoffs, gated by PI_WORKID_MODE. Unset or an explicit
 * off value keeps pi-handoff's pre-workid behavior; any other value activates
 * registry-backed identity. All registry access goes through the pi-workid
 * package; PI_WORKID_HOME is honored by that package's store.
 */

export const WORK_ID_FALLBACK_SLUG = "handoff-session"
const WORK_ID_MAX_CHARS = 40
const WORK_ID_MODE_OFF_VALUES = new Set(["", "0", "false", "off", "no"])

/** True when PI_WORKID_MODE enables work-id identity for this handoff. */
export function isWorkIdModeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env["PI_WORKID_MODE"]?.trim().toLowerCase()
  return value !== undefined && !WORK_ID_MODE_OFF_VALUES.has(value)
}

/** Derive a registry-valid slug from free text; falls back on any mismatch. */
export function deriveWorkIdSlug(focus: string): string {
  const slug = focus
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, WORK_ID_MAX_CHARS)
    .replace(/-+$/u, "")
  return WORK_ID_RE.test(slug) ? slug : WORK_ID_FALLBACK_SLUG
}

/** Addressable ref form: `<workId>#g<generation>`. */
export function workIdRef(workId: string, generation: number): string {
  return `${workId}#g${generation}`
}

/** Most recently updated active entry owned by `sessionId`, if any. */
export function findActiveOwnedEntry(
  store: WorkIdStore,
  sessionId: string,
): WorkIdEntry | undefined {
  const owned = store
    .list()
    .filter(
      (entry) =>
        entry.status === "active" && entry.current?.sessionId === sessionId,
    )
  owned.sort((a, b) => {
    const byUpdate = Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    if (byUpdate !== 0) return byUpdate
    return a.workId < b.workId ? -1 : 1
  })
  return owned[0]
}

export interface WorkIdPlan {
  store: WorkIdStore
  workId: string
  generation: number
  /** True when the workId was inherited from the parent session's entry. */
  inherited: boolean
}

/**
 * Read-only plan: inherit the parent session's active workId (generation + 1)
 * or derive a fresh slug at generation 1. Registry read failures return
 * undefined so the caller falls back to derived naming.
 */
export async function planWorkIdHandoff(options: {
  parentSession?: string
  focus: string
}): Promise<WorkIdPlan | undefined> {
  try {
    const store = await WorkIdStore.open()
    const parentEntry = options.parentSession
      ? findActiveOwnedEntry(store, options.parentSession)
      : undefined
    if (parentEntry?.current) {
      return {
        store,
        workId: parentEntry.workId,
        generation: parentEntry.generation + 1,
        inherited: true,
      }
    }
    return {
      store,
      workId: deriveWorkIdSlug(options.focus),
      generation: 1,
      inherited: false,
    }
  } catch (error) {
    console.error("work-id registry unavailable; continuing with derived naming:", error)
    return undefined
  }
}

/** Best-effort successor claim; false means continue without registry identity. */
export async function claimWorkIdForSuccessor(
  plan: WorkIdPlan,
  session: SessionInfo,
): Promise<boolean> {
  try {
    await plan.store.claim(plan.workId, session, null)
    return true
  } catch (error) {
    console.error(
      `work-id claim failed for "${workIdRef(plan.workId, plan.generation)}"; continuing with derived naming:`,
      error,
    )
    return false
  }
}

/** Roster lines for active entries owned in `cwd`: `workId#gN — sessionName`. */
export function buildWorkIdRosterLines(
  entries: readonly WorkIdEntry[],
  cwd: string,
): string[] {
  return entries
    .filter(
      (entry) => entry.status === "active" && entry.current?.cwd === cwd,
    )
    .sort((a, b) => (a.workId < b.workId ? -1 : 1))
    .map((entry) => {
      const owner = entry.current?.sessionName ?? ""
      return `${workIdRef(entry.workId, entry.generation)} — ${owner}`
    })
}

/** Body of the handoff document's `## Next session focus` section, if present. */
export function extractNextSessionFocus(document: string): string | undefined {
  const lines = document.split("\n")
  const start = lines.findIndex(
    (line) => line.trim() === "## Next session focus",
  )
  if (start === -1) return undefined
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break
    body.push(line)
  }
  const text = body.join("\n").trim()
  return text || undefined
}

export const MAX_SEED_PROMPT_CHARS = 2048
const MAX_FOCUS_CHARS = 400
const MAX_ROSTER_LINES = 10

export interface WorkIdSeedPromptInput {
  handoffPath: string
  workId: string
  generation: number
  focus?: string
  rosterLines?: readonly string[]
}

/** Mode-on successor seed prompt: ownership first, doc path, focus, roster. */
export function buildWorkIdSeedPrompt(input: WorkIdSeedPromptInput): string {
  const sections = [
    `You own workid ${workIdRef(input.workId, input.generation)} — peers address you by that id.`,
    `Continue from this handoff:\n${input.handoffPath}`,
  ]
  const focus = input.focus?.trim().slice(0, MAX_FOCUS_CHARS).trim()
  if (focus) sections.push(`Next session focus:\n${focus}`)
  const roster = input.rosterLines?.slice(0, MAX_ROSTER_LINES) ?? []
  if (roster.length > 0) {
    sections.push(`Live roster (active work in this directory):\n${roster.join("\n")}`)
  }
  sections.push("Read the handoff, load any suggested skills, then continue the work.")
  return sections.join("\n\n").slice(0, MAX_SEED_PROMPT_CHARS)
}

export interface WorkIdLaunchSeedInput {
  workIdRef: string
  handoffPath: string
}

/**
 * One-line successor seed for the `herdr agent start` argv. herdr rejects any
 * agent argument containing a newline (`invalid_agent_argument`), so the argv
 * seed must be a single line; the full handoff content lives in the handoff
 * document the seed points at.
 */
export function buildWorkIdLaunchSeed(input: WorkIdLaunchSeedInput): string {
  return `You own workid ${input.workIdRef}. Read ${input.handoffPath} and continue from it.`
}

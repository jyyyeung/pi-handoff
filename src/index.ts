import { randomUUID } from "node:crypto"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Message } from "@earendil-works/pi-ai/compat"
import {
  generateRename,
  getUserMessageContext,
  resolveInitialModelConfig,
  sanitizeRenameText,
} from "./rename/naming.js"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent"
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent"
import { completeText } from "./complete-text.js"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HANDOFF_SKILL_COMMAND = "skill:handoff"
const HANDOFF_BRIDGE_COMMAND = "__pi-handoff-session"
export const HANDOFF_SESSION_PREFIX = "[handoff] "

export function formatHandoffSessionName(baseName: string): string {
  return `${HANDOFF_SESSION_PREFIX}${baseName}`
}

const HANDED_OFF_SESSION_PREFIX = "[handed-off] "
const HANDOFF_TAB_CLOSE_DELAY_MS = 3_000

export type HandoffReason = "budget" | "voluntary"

const HANDOFF_REASON_ARG_RE = /^--reason=(budget|voluntary)(?:\s+|$)/

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Generate a handoff markdown document for a fresh coding agent.

Follow the provided handoff skill instructions as the document policy.

Requirements:
- Base the handoff only on the supplied conversation and session metadata.
- Tailor the document to the next session focus.
- Include concrete decisions, files, commands/checks, blockers, and next steps when relevant.
- Include a "Suggested skills" section.
- Reference existing artifacts by path or URL instead of duplicating their content.
- Redact sensitive information such as API keys, passwords, tokens, and personally identifiable information.
- Keep it concise and actionable.
- Output only markdown for the handoff document. Do not include a preamble or closing note.`

type HandoffSkill = {
  path: string
  instructions: string
}

async function loadHandoffSkill(
  pi: ExtensionAPI,
): Promise<HandoffSkill | undefined> {
  const command = pi
    .getCommands()
    .find(
      (candidate: SlashCommandInfo) =>
        candidate.source === "skill" &&
        candidate.name === HANDOFF_SKILL_COMMAND,
    )
  if (!command?.sourceInfo.path) return undefined

  return {
    path: command.sourceInfo.path,
    instructions: await readFile(command.sourceInfo.path, "utf8"),
  }
}

function dateStamp(): string {
  const [date] = new Date().toISOString().split("T")
  return date ?? "handoff"
}

async function nextHandoffPath(slug: string): Promise<string> {
  const directory = join(tmpdir(), "pi-handoffs")
  await mkdir(directory, { recursive: true })

  const baseName = `pi-handoff-${dateStamp()}-${slug}`
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`
    const path = join(directory, `${baseName}${suffix}.md`)
    if (!existsSync(path)) return path
  }

  throw new Error("Could not allocate a unique handoff file path")
}

export async function resolveHandoffBaseName(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  messages: readonly AgentMessage[],
  focus: string,
): Promise<string> {
  // Priority: an explicit focus states what the next session does; a named
  // parent carries the lineage of the work (stable across chained handoffs);
  // the rename model generalizes over the parent conversation. The raw
  // last-user-message fallback is what produced names like
  // "new-intercom-message-above" and is no longer reachable from here.
  if (focus !== DEFAULT_HANDOFF_FOCUS) {
    const focusName = sanitizeRenameText(focus)
    if (focusName) return focusName
  }

  const parentName = pi.getSessionName()?.trim()
  if (parentName) {
    const stripped = parentName.startsWith(HANDOFF_SESSION_PREFIX)
      ? parentName.slice(HANDOFF_SESSION_PREFIX.length)
      : parentName
    if (stripped) return stripped
  }

  const context = getUserMessageContext(messages)
  if (!context) return sanitizeRenameText(focus) || "handoff-session"

  const result = await generateRename(ctx, resolveInitialModelConfig(), context)
  return result?.name ?? "handoff-session"
}

function buildNewSessionPrompt(handoffPath: string): string {
  return [
    "Continue from this handoff:",
    handoffPath,
    "Read the handoff, load any suggested skills, then continue the work.",
  ].join("\n\n")
}

type HerdrTabCreateResponse = {
  result?: {
    root_pane?: {
      pane_id?: unknown
    }
  }
}

function getHerdrWorkspaceId(): string | undefined {
  if (process.env["HERDR_ENV"] !== "1") return undefined

  const workspaceId = process.env["HERDR_WORKSPACE_ID"]?.trim()
  if (!workspaceId) {
    throw new Error("Herdr workspace context is unavailable")
  }
  return workspaceId
}

function getHerdrRootPaneId(stdout: string): string | undefined {
  try {
    const response = JSON.parse(stdout) as HerdrTabCreateResponse
    const paneId = response.result?.root_pane?.pane_id
    return typeof paneId === "string" && paneId.trim() ? paneId : undefined
  } catch {
    return undefined
  }
}

function getCommandError(stdout: string, stderr: string): string {
  return stderr.trim() || stdout.trim() || "unknown error"
}

type HerdrCommandResult = {
  code: number
  stdout: string
  stderr: string
}

const HERDR_AGENT_START_ATTEMPTS = 20
const HERDR_AGENT_START_RETRY_DELAY_MS = 250

export function startHerdrAgentWithRetry(
  start: () => Promise<HerdrCommandResult>,
): Promise<void> {
  async function attemptStart(attempt: number): Promise<void> {
    const result = await start()
    if (result.code === 0) return

    const error = getCommandError(result.stdout, result.stderr)
    if (
      !error.includes("agent_pane_busy") ||
      attempt === HERDR_AGENT_START_ATTEMPTS - 1
    ) {
      throw new Error(`Could not start Pi in Herdr tab: ${error}`)
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, HERDR_AGENT_START_RETRY_DELAY_MS)
    })
    return attemptStart(attempt + 1)
  }

  return attemptStart(0)
}

async function startHandoffInHerdr(options: {
  pi: ExtensionAPI
  ctx: ExtensionCommandContext
  handoffPath: string
  parentSession: string | undefined
  sessionName: string
  workspaceId: string
}): Promise<void> {
  const childSessionManager = SessionManager.create(
    options.ctx.cwd,
    undefined,
    options.parentSession
      ? { parentSession: options.parentSession }
      : undefined,
  )
  const childSessionPath = childSessionManager.getSessionFile()
  const childSessionHeader = childSessionManager.getHeader()
  if (!childSessionPath || !childSessionHeader) {
    throw new Error("Could not create a persisted handoff session")
  }
  await mkdir(childSessionManager.getSessionDir(), { recursive: true })
  await writeFile(childSessionPath, `${JSON.stringify(childSessionHeader)}\n`, {
    flag: "wx",
  })

  const createdTab = await options.pi.exec(
    "herdr",
    [
      "tab",
      "create",
      "--workspace",
      options.workspaceId,
      "--cwd",
      options.ctx.cwd,
      "--label",
      options.sessionName,
    ],
    { timeout: 5_000 },
  )
  if (createdTab.code !== 0) {
    throw new Error(
      `Could not create Herdr tab: ${getCommandError(createdTab.stdout, createdTab.stderr)}`,
    )
  }

  const rootPaneId = getHerdrRootPaneId(createdTab.stdout)
  if (!rootPaneId) {
    throw new Error("Could not find the new Herdr tab's root pane")
  }

  const agentName = `handoff-${randomUUID().slice(0, 8)}`
  const model = options.ctx.model!

  await startHerdrAgentWithRetry(() =>
    options.pi.exec(
      "herdr",
      [
        "agent",
        "start",
        agentName,
        "--kind",
        "pi",
        "--pane",
        rootPaneId,
        "--",
        "--session",
        childSessionPath,
        "--name",
        options.sessionName,
        "--provider",
        model.provider,
        "--model",
        model.id,
      ],
      { timeout: 35_000 },
    ),
  )

  await promptHerdrAgentVerified(
    options.pi,
    agentName,
    buildNewSessionPrompt(options.handoffPath),
  )
}

const HANDOFF_PROMPT_TIMEOUT_MS = 20_000

function isEngagedHerdrStatus(status: unknown): boolean {
  return status === "working" || status === "blocked" || status === "done"
}

async function herdrAgentEngaged(
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

async function promptHerdrAgentVerified(
  pi: ExtensionAPI,
  agentName: string,
  text: string,
): Promise<void> {
  const promptArgs = [
    "agent",
    "prompt",
    agentName,
    text,
    "--wait",
    "--until",
    "working",
    "--timeout",
    String(HANDOFF_PROMPT_TIMEOUT_MS),
  ]
  const attempts = 2
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await pi.exec("herdr", promptArgs, { timeout: 30_000 })
    if (result.code === 0) return
    // A non-zero exit can also mean the final-state match timed out on an
    // agent that already took the prompt; trust the observed status over the
    // exit code before retrying.
    if (await herdrAgentEngaged(pi, agentName)) return
    if (attempt === attempts) {
      throw new Error(
        `Could not deliver the handoff prompt: ${getCommandError(result.stdout, result.stderr)}`,
      )
    }
  }
}

type HerdrSelfAgent = { name?: string; tabId?: string }

async function findHerdrSelfAgent(
  pi: ExtensionAPI,
  parentSession: string,
): Promise<HerdrSelfAgent | undefined> {
  const listed = await pi.exec("herdr", ["agent", "list"], { timeout: 5_000 })
  if (listed.code !== 0) return undefined
  try {
    const agents = (
      JSON.parse(listed.stdout) as {
        result?: {
          agents?: Array<{
            name?: unknown
            tab_id?: unknown
            agent_session?: { value?: unknown }
          }>
        }
      }
    )?.result?.agents
    const self = agents?.find(
      (candidate) => candidate?.agent_session?.value === parentSession,
    )
    if (!self) return undefined
    return {
      name: typeof self.name === "string" ? self.name : undefined,
      tabId: typeof self.tab_id === "string" ? self.tab_id : undefined,
    }
  } catch {
    return undefined
  }
}

async function retireParentInHerdr(options: {
  pi: ExtensionAPI
  parentSession: string
  baseSessionName: string
}): Promise<string | undefined> {
  const currentName = options.pi.getSessionName()?.trim()
  const stripped = (currentName ?? options.baseSessionName)
    .replace(HANDED_OFF_SESSION_PREFIX, "")
    .replace(HANDOFF_SESSION_PREFIX, "")
  try {
    options.pi.setSessionName(`${HANDED_OFF_SESSION_PREFIX}${stripped}`)
  } catch (error) {
    console.error("Could not mark the handed-off session name:", error)
  }

  const self = await findHerdrSelfAgent(options.pi, options.parentSession)
  if (self?.name) {
    try {
      await options.pi.exec(
        "herdr",
        [
          "agent",
          "rename",
          self.name,
          `handed-off-${self.name.replace(/^handoff-/, "")}`,
        ],
        { timeout: 5_000 },
      )
    } catch (error) {
      console.error("Could not rename the handed-off agent:", error)
    }
  }
  return self?.tabId
}

function buildDocumentWithMetadata(options: {
  generated: string
  focus: string
  handoffSkillPath: string
  parentSession: string | undefined
  reason: HandoffReason
}): string {
  const previousSession = options.parentSession
    ? [
        "## Previous session",
        "",
        `- Session file: \`${options.parentSession}\``,
        "- If details are missing, use `session_query` with that session file.",
        `- Handoff reason: ${options.reason}`,
      ].join("\n")
    : [
        "## Previous session",
        "",
        "- No persisted previous session file was available.",
        `- Handoff reason: ${options.reason}`,
      ].join("\n")

  return [
    `# Handoff: ${options.focus}`,
    "",
    "## Next session focus",
    "",
    options.focus,
    "",
    previousSession,
    "",
    "## Handoff policy",
    "",
    "- Skill: `handoff`",
    `- Source: \`${options.handoffSkillPath}\``,
    "",
    options.generated.trim(),
    "",
  ].join("\n")
}

async function generateHandoffDocument(options: {
  ctx: ExtensionCommandContext
  handoffSkill: HandoffSkill
  messages: AgentMessage[]
  focus: string
  parentSession: string | undefined
  signal?: AbortSignal
}): Promise<string | null> {
  const model = options.ctx.model
  if (!model) throw new Error("No model selected")

  const conversationText = serializeConversation(convertToLlm(options.messages))
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "## Handoff Skill Instructions",
          "",
          options.handoffSkill.instructions,
          "",
          "## Session Metadata",
          "",
          `- Previous session file: ${options.parentSession ?? "not available"}`,
          `- Handoff skill path: ${options.handoffSkill.path}`,
          "",
          "## Next Session Focus",
          "",
          options.focus,
          "",
          "## Conversation History",
          "",
          conversationText,
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  }

  return completeText(
    options.ctx,
    model,
    HANDOFF_SYSTEM_PROMPT,
    userMessage,
    options.signal,
  )
}

const DEFAULT_HANDOFF_FOCUS = "continue the current work"
const HANDOFF_REQUEST_RE = /(^|\s)-handoff(?=\s|$)/

function getHandoffFocus(text: string): string | undefined {
  if (!HANDOFF_REQUEST_RE.test(text)) return undefined
  return text.replace(HANDOFF_REQUEST_RE, " ").trim() || DEFAULT_HANDOFF_FOCUS
}

async function runHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  focus: string,
  reason: HandoffReason = "voluntary",
): Promise<void> {
  if (!ctx.model) {
    ctx.ui.notify("No model selected.", "error")
    return
  }

  const handoffSkill = await loadHandoffSkill(pi)
  if (!handoffSkill) {
    ctx.ui.notify(
      "Handoff requires a discoverable skill named exactly `handoff`. Install it, then run /reload.",
      "error",
    )
    return
  }

  const messages = ctx.sessionManager
    .buildContextEntries()
    .flatMap(sessionEntryToContextMessages)
  if (messages.length === 0) {
    ctx.ui.notify("No conversation to hand off.", "error")
    return
  }

  const parentSession = ctx.sessionManager.getSessionFile() ?? undefined
  const generated = await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const model = ctx.model
      const modelLabel = model
        ? `${model.provider}/${"id" in model ? model.id : "selected"}`
        : "selected model"
      const loader = new BorderedLoader(
        tui,
        theme,
        `Generating handoff with ${modelLabel}...`,
      )
      loader.onAbort = () => done(null)

      generateHandoffDocument({
        ctx,
        handoffSkill,
        messages,
        focus,
        parentSession,
        signal: loader.signal,
      })
        .then(done)
        .catch((error) => {
          console.error("Handoff generation failed:", error)
          done(
            `__ERROR__${error instanceof Error ? error.message : String(error)}`,
          )
        })

      return loader
    },
  )

  if (generated === null) {
    ctx.ui.notify("Handoff session cancelled.", "warning")
    return
  }
  if (generated.startsWith("__ERROR__")) {
    ctx.ui.notify(generated.slice("__ERROR__".length), "error")
    return
  }

  const baseSessionName = await resolveHandoffBaseName(pi, ctx, messages, focus)
  const sessionName = formatHandoffSessionName(baseSessionName)
  const handoffPath = await nextHandoffPath(baseSessionName)
  const document = buildDocumentWithMetadata({
    generated,
    focus,
    handoffSkillPath: handoffSkill.path,
    parentSession,
    reason,
  })
  await writeFile(handoffPath, document, "utf8")

  const herdrWorkspaceId = getHerdrWorkspaceId()
  if (herdrWorkspaceId) {
    await startHandoffInHerdr({
      pi,
      ctx,
      handoffPath,
      parentSession,
      sessionName,
      workspaceId: herdrWorkspaceId,
    })
    const tabId = parentSession
      ? await retireParentInHerdr({ pi, parentSession, baseSessionName })
      : undefined
    if (reason === "budget" && process.env["PI_HANDOFF_KEEP_TAB"] !== "1") {
      ctx.ui.notify(
        `Handoff opened in a new Herdr tab: ${handoffPath}. Budget wrap-up: this tab closes shortly.`,
        "info",
      )
      await delay(HANDOFF_TAB_CLOSE_DELAY_MS)
      if (tabId) {
        try {
          await pi.exec("herdr", ["tab", "close", tabId], { timeout: 5_000 })
        } catch (error) {
          console.error("Could not close the handed-off tab:", error)
        }
      }
      return
    }
    ctx.ui.notify(
      `Handoff opened in a new Herdr tab: ${handoffPath}. This tab is marked [handed-off].`,
      "info",
    )
    return
  }

  await ctx.newSession({
    ...(parentSession ? { parentSession } : {}),
    setup: async (sessionManager) => {
      sessionManager.appendSessionInfo(sessionName)
    },
    withSession: async (newCtx) => {
      newCtx.ui.notify(`Handoff written: ${handoffPath}`, "info")
      await newCtx.sendUserMessage(buildNewSessionPrompt(handoffPath))
    },
  })
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand(HANDOFF_BRIDGE_COMMAND, {
    description: "Internal handoff bridge; use the -handoff marker instead.",
    handler: async (args, ctx) => {
      const reasonMatch = HANDOFF_REASON_ARG_RE.exec(args)
      const reason = (reasonMatch?.[1] as HandoffReason | undefined) ?? "voluntary"
      const focus = (
        reasonMatch ? args.slice(reasonMatch[0].length) : args
      ).trim() || DEFAULT_HANDOFF_FOCUS
      try {
        await runHandoff(pi, ctx, focus, reason)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error("Handoff session failed:", error)
        ctx.ui.notify(message, "error")
      }
    },
  })

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || ctx.mode !== "tui") {
      return { action: "continue" }
    }

    const focus = getHandoffFocus(event.text)
    if (focus === undefined) return { action: "continue" }

    pi.sendUserMessage(`/${HANDOFF_BRIDGE_COMMAND} ${focus}`, {
      expandPromptTemplates: true,
    })
    return { action: "handled" }
  })
}

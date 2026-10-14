import type { Message } from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
  SessionManager,
  convertToLlm,
  serializeConversation,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent"
import { completeText } from "./complete-text.js"
import { resolveInitialRenameConfig } from "./rename/naming.js"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

// Query model resolution: the configured rename model (pi-rename.json) first,
// then the session model. The upstream constant pointed at openai-codex,
// which is not authenticated on this machine and made session_query fail.
function resolveQueryModel(ctx: ExtensionContext) {
  const config = resolveInitialRenameConfig().modelConfig
  if (config.kind === "configured") {
    const configured = ctx.modelRegistry.find(
      config.model.provider,
      config.model.id,
    )
    if (configured) return configured
  }
  return ctx.model ?? undefined
}

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given a pi coding session and a question, answer based only on that session.

Focus on:
- decisions made
- files discussed or changed
- concrete outcomes and next steps

Be concise and direct. If the session does not contain the answer, say so.`

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: true },
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_query",
    label: "Session Query",
    description:
      "Query a previous pi session file for context, decisions, or code changes.",
    parameters: Type.Object({
      sessionPath: Type.String({
        description: "Full path to a .jsonl pi session file",
      }),
      question: Type.String({
        description: "What you want to know about that session",
      }),
    }),
    renderCall(args, theme, _context) {
      const question =
        typeof args.question === "string" && args.question.length > 0
          ? args.question
          : "(loading question...)"
      const text = [
        theme.fg("toolTitle", theme.bold("session_query")),
        theme.fg("accent", question),
      ].join("\n")

      return new Text(text, 0, 0)
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.sessionPath.endsWith(".jsonl")) {
        return errorResult(`Error: Invalid session path: ${params.sessionPath}`)
      }

      try {
        const fs = await import("node:fs")
        if (!fs.existsSync(params.sessionPath)) {
          return errorResult(
            `Error: Session file not found: ${params.sessionPath}`,
          )
        }
      } catch (err) {
        return errorResult(`Error checking session file: ${err}`)
      }

      let sessionManager: SessionManager
      try {
        sessionManager = SessionManager.open(params.sessionPath)
      } catch (err) {
        return errorResult(`Error loading session: ${err}`)
      }

      const messages = sessionManager
        .buildContextEntries()
        .flatMap(sessionEntryToContextMessages)

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Session is empty." }],
          details: { empty: true },
        }
      }

      const model = resolveQueryModel(ctx)
      if (!model) {
        return errorResult(
          "Error: No query model available (configure pi-rename.json or select a session model).",
        )
      }

      const conversationText = serializeConversation(convertToLlm(messages))
      const userMessage: Message = {
        role: "user",
        content: [
          {
            type: "text",
            text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${params.question}`,
          },
        ],
        timestamp: Date.now(),
      }

      try {
        const answer = await completeText(
          ctx,
          model,
          QUERY_SYSTEM_PROMPT,
          userMessage,
          signal,
        )
        if (answer === null) {
          return {
            content: [{ type: "text" as const, text: "Query was cancelled." }],
            details: { cancelled: true },
          }
        }

        return {
          content: [{ type: "text" as const, text: answer }],
          details: {
            sessionPath: params.sessionPath,
            question: params.question,
            messageCount: messages.length,
          },
        }
      } catch (err) {
        return errorResult(
          `Error querying session: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  })
}

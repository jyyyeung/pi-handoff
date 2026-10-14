import { complete, type Message } from "@earendil-works/pi-ai/compat"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

export async function completeText(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: NonNullable<ExtensionContext["model"]>,
  systemPrompt: string,
  message: Message,
  signal?: AbortSignal,
): Promise<string | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok) throw new Error(auth.error)

  const response = await complete(
    model,
    { systemPrompt, messages: [message] },
    {
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.headers ? { headers: auth.headers } : {}),
      ...(signal ? { signal } : {}),
    },
  )

  if (response.stopReason === "aborted") return null

  return response.content
    .filter((content): content is { type: "text"; text: string } => {
      return content.type === "text"
    })
    .map((content) => content.text)
    .join("\n")
    .trim()
}

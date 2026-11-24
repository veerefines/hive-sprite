/**
 * Sprites connectors.
 *
 * Every outside API that needs a key goes through the Sprites gateway:
 *   https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>
 * The Sprite never holds the token. The gateway knows which Sprite is
 * calling from Fly.io's request signature and attaches the stored credential.
 *
 * Configure the base URLs (copied from each connector's detail page) in
 * env: HIVE_LLM_GATEWAY and HIVE_SLACK_GATEWAY.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmReply {
  content: string | null
  tool_calls?: ToolCall[]
}

export type Llm = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<LlmReply>

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * OpenAI-compatible chat completions through the OpenRouter (or any
 * OpenAI-compatible) connector. Base URL example:
 *   https://api.sprites.dev/v1/gateway/openrouter/conn_abc123/v1
 */
export function gatewayLlm(
  base = process.env.HIVE_LLM_GATEWAY ?? '',
  model = process.env.HIVE_MODEL ?? 'meta-llama/llama-3.3-70b-instruct',
  fetchImpl: typeof fetch = fetch,
): Llm {
  if (!base) throw new Error('HIVE_LLM_GATEWAY is not set: point it at your LLM connector URL')
  return async (messages, tools) => {
    const res = await fetchImpl(`${trimSlash(base)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.3 }),
    })
    if (!res.ok) throw new Error(`LLM connector ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const data = (await res.json()) as { choices?: Array<{ message?: LlmReply }> }
    const msg = data.choices?.[0]?.message
    if (!msg) throw new Error('LLM connector returned no message')
    return { content: msg.content ?? null, tool_calls: msg.tool_calls }
  }
}

/**
 * Post to Slack through the Slack connector. Base URL example:
 *   https://api.sprites.dev/v1/gateway/slack_bot/conn_def456
 */
export async function slackPost(
  channel: string,
  text: string,
  base = process.env.HIVE_SLACK_GATEWAY ?? '',
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  if (!base) return { ok: false, error: 'Slack connector not configured (HIVE_SLACK_GATEWAY)' }
  const res = await fetchImpl(`${trimSlash(base)}/chat.postMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  return { ok: !!data.ok, error: data.ok ? undefined : (data.error ?? `HTTP ${res.status}`) }
}

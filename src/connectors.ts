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
export const FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'google/gemma-4-31b-it:free',
  'inclusionai/ling-3.2-flash:free',
]

export function modelChain(env = process.env): string[] {
  const list = (env.HIVE_MODELS ?? env.HIVE_MODEL ?? '').split(',').map((m) => m.trim()).filter(Boolean)
  const chain = list.length ? list : FREE_MODELS
  // Free tier only unless explicitly allowed: paid model ids are dropped.
  return env.HIVE_ALLOW_PAID === '1' ? chain : chain.filter((m) => m.endsWith(':free'))
}

/**
 * OpenAI-compatible chat completions through the OpenRouter connector.
 * Tries each model in the chain; a 429/5xx (free models get rate-limited
 * upstream) moves on to the next one. Every attempt is reported to onCall
 * first, so the caller can count it against the day's allowance.
 */
export function gatewayLlm(
  base = process.env.HIVE_LLM_GATEWAY ?? '',
  models: string | string[] = modelChain(),
  fetchImpl: typeof fetch = fetch,
  maxTokens = Number(process.env.HIVE_MAX_TOKENS ?? 6000),
  onCall: (model: string) => void = () => {},
): Llm {
  if (!base) throw new Error('HIVE_LLM_GATEWAY is not set: point it at your LLM connector URL')
  const chain = Array.isArray(models) ? models : [models]
  if (!chain.length) throw new Error('No allowed models (free tier only: set HIVE_MODELS to ids ending in :free)')
  let preferred = 0
  return async (messages, tools) => {
    let lastErr = ''
    for (let k = 0; k < chain.length; k++) {
      const i = (preferred + k) % chain.length
      const model = chain[i]
      onCall(model)
      const res = await fetchImpl(`${trimSlash(base)}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.3, max_tokens: maxTokens }),
      })
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: LlmReply }>; error?: { message?: string } }
        const msg = data.choices?.[0]?.message
        if (msg) {
          preferred = i // stick with a model that answers
          return { content: msg.content ?? null, tool_calls: msg.tool_calls }
        }
        lastErr = data.error?.message ?? 'no message'
        continue
      }
      lastErr = `${res.status}: ${(await res.text()).slice(0, 200)}`
      if (res.status !== 429 && res.status < 500) break
    }
    throw new Error(`LLM connector failed (${lastErr})`)
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

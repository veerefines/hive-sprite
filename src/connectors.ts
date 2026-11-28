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
 * Extract tool calls from free models that emit them as XML-like text in content
 * instead of structured tool_calls. Common patterns:
 *   <tool_call><function=propose_plan><parameter=title>...</parameter>...</function></tool_call>
 *   > propose_plan> title> Mumbai... </parameter> stay> {...}
 */
function extractToolCalls(msg: LlmReply): LlmReply {
  // If structured tool_calls exist, use them as-is
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return { content: msg.content ?? null, tool_calls: msg.tool_calls }
  }

  const content = msg.content ?? ''
  if (typeof content !== 'string') {
    return { content: msg.content ?? null, tool_calls: undefined }
  }

  const extracted: ToolCall[] = []
  let cleanContent = content

  // Pattern 1: <tool_call>...</tool_call> blocks
  const xmlPattern = /<tool_call>\s*<function=([^>]+)>(.*?)<\/function>\s*<\/tool_call>/gs
  const xmlMatches = [...content.matchAll(xmlPattern)]

  for (const match of xmlMatches) {
    const functionName = match[1].trim()
    const paramsBlock = match[2]

    // Extract <parameter=KEY>VALUE</parameter> pairs
    const paramPattern = /<parameter=([^>]+)>(.*?)<\/parameter>/gs
    const params: Record<string, unknown> = {}
    let paramMatch: RegExpExecArray | null

    while ((paramMatch = paramPattern.exec(paramsBlock)) !== null) {
      const key = paramMatch[1].trim()
      const value = paramMatch[2].trim()

      // Try to parse as JSON for nested structures, otherwise keep as string
      try {
        params[key] = JSON.parse(value)
      } catch {
        params[key] = value
      }
    }

    // Create a synthetic tool call
    extracted.push({
      id: `call_${Date.now()}_${extracted.length}`,
      type: 'function',
      function: {
        name: functionName,
        arguments: JSON.stringify(params),
      },
    })

    // Remove this tool call block from content
    cleanContent = cleanContent.replace(match[0], '')
  }

  // Pattern 2: > function_name> param> value format
  const arrowPattern = />\s*(propose_plan|find_places|remember|geocode)\s*>[\s\S]*?(?=\n\n|$)/g
  const arrowMatches = [...content.matchAll(arrowPattern)]

  for (const match of arrowMatches) {
    // If we find this pattern, just strip it - it's too malformed to parse reliably
    cleanContent = cleanContent.replace(match[0], '')
  }

  // Clean up any leftover whitespace
  cleanContent = cleanContent.trim()

  return {
    content: cleanContent || null,
    tool_calls: extracted.length > 0 ? extracted : undefined,
  }
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
  base: string | undefined = process.env.HIVE_LLM_GATEWAY,
  models: string | string[] = modelChain(),
  fetchImpl: typeof fetch = fetch,
  maxTokens = Number(process.env.HIVE_MAX_TOKENS ?? 6000),
  onCall: (model: string) => void = () => {},
  env = process.env,
): Llm {
  const apiKey = env.OPENROUTER_API_KEY
  const directOpenRouter = !base && !!apiKey
  const endpoint = base ?? (directOpenRouter ? 'https://openrouter.ai/api/v1' : '')
  if (!endpoint) throw new Error('Configure OPENROUTER_API_KEY or HIVE_LLM_GATEWAY to enable the LLM connector')
  const headers = {
    'content-type': 'application/json',
    ...(directOpenRouter && apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
  const chain = Array.isArray(models) ? models : [models]
  if (!chain.length) throw new Error('No allowed models (free tier only: set HIVE_MODELS to ids ending in :free)')
  let preferred = 0
  return async (messages, tools) => {
    let lastErr = ''
    for (let k = 0; k < chain.length; k++) {
      const i = (preferred + k) % chain.length
      const model = chain[i]
      onCall(model)
      let res: Response
      try {
        res = await fetchImpl(`${trimSlash(endpoint)}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(Number(env.HIVE_LLM_TIMEOUT_MS ?? 150_000)),
        headers,
        body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), temperature: 0.3, max_tokens: maxTokens }),
        })
      } catch (err) {
        lastErr = `${model} timed out`
        continue
      }
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: LlmReply }>; error?: { message?: string } }
        const msg = data.choices?.[0]?.message
        if (msg) {
          preferred = i // stick with a model that answers
          return extractToolCalls(msg)
        }
        lastErr = data.error?.message ?? 'no message'
        continue
      }
      const upstreamError = (await res.text()).slice(0, 200)
      lastErr = `${res.status}: ${apiKey ? upstreamError.replaceAll(apiKey, '[redacted]') : upstreamError}`
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

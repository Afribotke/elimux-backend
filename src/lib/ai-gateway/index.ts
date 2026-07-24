import { randomUUID } from 'crypto'
import { supabase } from '../supabase'
import { DeepSeekProvider } from './providers/deepseek'
import { KimiProvider } from './providers/kimi'
import { OpenAIProvider } from './providers/openai'
import { AnthropicProvider } from './providers/anthropic'

export interface AIProvider {
  name: string
  chat(messages: any[], options?: any): Promise<any>
  embeddings(text: string): Promise<{ embedding: number[]; usage?: any }>
  isAvailable(): boolean
  getCostEstimate(inputTokens: number, outputTokens: number): number
}

export type AIMode = 'launch' | 'scale'

// launch = quality-first (Anthropic primary) for the pre-scale phase.
// DeepSeek is deliberately excluded here - it's reserved for scale mode's
// cost-first chat path, not used at all during launch.
// scale = cost-first (DeepSeek primary) once volume makes per-call cost matter.
const CHAT_MODE_ORDERS: Record<AIMode, string[]> = {
  launch: ['anthropic', 'openai', 'kimi'],
  scale: ['deepseek', 'openai', 'kimi', 'anthropic'],
}

const ALL_PROVIDERS: AIProvider[] = [
  new AnthropicProvider(),
  new OpenAIProvider(),
  new KimiProvider(),
  new DeepSeekProvider(),
]

function normalizeUsage(providerName: string, usage: any): { inputTokens: number; outputTokens: number } {
  if (!usage) return { inputTokens: 0, outputTokens: 0 }
  if (providerName === 'anthropic') {
    return { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
  }
  // OpenAI-compatible SDK shape (openai, deepseek, kimi all go through the
  // `openai` package's chat.completions.create)
  return { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 }
}

interface UsageLogEntry {
  requestId: string
  provider: string
  model: string | null
  endpoint: 'chat' | 'embed'
  inputTokens: number
  outputTokens: number
  costUsd: number
  status: 'success' | 'error'
  errorMessage?: string
}

export class AIClient {
  private allProviders: AIProvider[]
  private mode: AIMode

  constructor() {
    this.allProviders = ALL_PROVIDERS
    this.mode = process.env.AI_MODE === 'scale' ? 'scale' : 'launch'
  }

  getMode(): AIMode {
    return this.mode
  }

  // In-memory only - resets to AI_MODE (or 'launch') on restart/redeploy.
  // If mode needs to survive restarts, persist it (e.g. platform_settings)
  // and read it back in the constructor instead.
  setMode(mode: string): AIMode {
    if (mode !== 'launch' && mode !== 'scale') {
      throw new Error(`Unknown mode: ${mode}. Must be "launch" or "scale"`)
    }
    this.mode = mode
    return this.mode
  }

  private orderedChatProviders(): AIProvider[] {
    const order =
      process.env.AI_FALLBACK_ORDER?.split(',').map((s) => s.trim()).filter(Boolean) ??
      CHAT_MODE_ORDERS[this.mode]

    // Filter to providers actually in the order list (not just sort by it) -
    // indexOf(-1) for an excluded provider would otherwise sort it first.
    return this.allProviders
      .filter((p) => p.isAvailable() && order.includes(p.name))
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
  }

  private async logUsage(entry: UsageLogEntry) {
    try {
      await supabase.from('ai_usage').insert({
        request_id: entry.requestId,
        provider: entry.provider,
        model: entry.model,
        endpoint: entry.endpoint,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cost_usd: entry.costUsd,
        status: entry.status,
        error_message: entry.errorMessage ?? null,
      })
    } catch (err: any) {
      // Logging must never break the actual AI call.
      console.error('[AI] Failed to log ai_usage:', err.message)
    }
  }

  private async chatAndLog(provider: AIProvider, messages: any[], options: any, requestId: string) {
    try {
      const result = await provider.chat(messages, options)
      const { inputTokens, outputTokens } = normalizeUsage(provider.name, result.usage)
      await this.logUsage({
        requestId,
        provider: provider.name,
        model: result.model ?? null,
        endpoint: 'chat',
        inputTokens,
        outputTokens,
        costUsd: provider.getCostEstimate(inputTokens, outputTokens),
        status: 'success',
      })
      return result
    } catch (error: any) {
      await this.logUsage({
        requestId,
        provider: provider.name,
        model: null,
        endpoint: 'chat',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        status: 'error',
        errorMessage: error.message,
      })
      throw error
    }
  }

  async chat(options: { messages: any[]; model?: string; temperature?: number }) {
    const { messages, model = 'auto', temperature = 0.7 } = options
    const providers = this.orderedChatProviders()
    const requestId = randomUUID()

    if (providers.length === 0) {
      throw new Error('No AI providers configured - set at least one *_API_KEY env var')
    }

    if (model !== 'auto') {
      const provider = providers.find((p) => p.name === model)
      if (!provider) throw new Error(`Provider ${model} not available`)
      return this.chatAndLog(provider, messages, { temperature }, requestId)
    }

    const errors: string[] = []
    for (const provider of providers) {
      try {
        console.log(`[AI] Trying ${provider.name}...`)
        const result = await this.chatAndLog(provider, messages, { temperature }, requestId)
        console.log(`[AI] Success with ${provider.name}`)
        return result
      } catch (error: any) {
        console.error(`[AI] ${provider.name} failed: ${error.message}`)
        errors.push(`${provider.name}: ${error.message}`)
      }
    }

    throw new Error(`All AI providers failed: ${errors.join('; ')}`)
  }

  // Embeddings are OpenAI-only: Anthropic has no embeddings API, and
  // DeepSeek/Kimi don't publish one either (DeepSeek's documented-looking
  // `deepseek-embedding` model 404s in practice, confirmed live 2026-07-24).
  // No fallback chain - if OpenAI isn't configured, this fails outright.
  async embeddings(text: string): Promise<number[]> {
    const provider = this.allProviders.find((p) => p.name === 'openai')
    const requestId = randomUUID()

    if (!provider || !provider.isAvailable()) {
      await this.logUsage({
        requestId,
        provider: 'openai',
        model: null,
        endpoint: 'embed',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        status: 'error',
        errorMessage: 'OPENAI_API_KEY not set',
      })
      throw new Error('OpenAI not configured - OPENAI_API_KEY required for embeddings')
    }

    try {
      const { embedding, usage } = await provider.embeddings(text)
      const inputTokens = usage?.prompt_tokens ?? Math.ceil(text.length / 4)
      // text-embedding-3-small: $0.02 / 1M input tokens, no output tokens.
      // Not provider.getCostEstimate() - that method is calibrated for this
      // provider's chat model (gpt-4o-mini), a very different price point.
      const costUsd = (inputTokens * 0.02) / 1_000_000

      await this.logUsage({
        requestId,
        provider: provider.name,
        model: 'text-embedding-3-small',
        endpoint: 'embed',
        inputTokens,
        outputTokens: 0,
        costUsd,
        status: 'success',
      })
      return embedding
    } catch (error: any) {
      await this.logUsage({
        requestId,
        provider: provider.name,
        model: null,
        endpoint: 'embed',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        status: 'error',
        errorMessage: error.message,
      })
      throw error
    }
  }

  getAvailableProviders() {
    return this.allProviders.map((p) => ({ name: p.name, available: p.isAvailable() }))
  }

  getStatus() {
    return {
      mode: this.mode,
      order: CHAT_MODE_ORDERS[this.mode],
      embeddingsProvider: 'openai',
      providers: this.getAvailableProviders(),
    }
  }
}

export const aiClient = new AIClient()

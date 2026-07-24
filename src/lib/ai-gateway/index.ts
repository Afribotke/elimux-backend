import { randomUUID } from 'crypto'
import { supabase } from '../supabase'
import { DeepSeekProvider } from './providers/deepseek'
import { KimiProvider } from './providers/kimi'
import { OpenAIProvider } from './providers/openai'
import { AnthropicProvider } from './providers/anthropic'
import { TogetherProvider } from './providers/together'

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
  new TogetherProvider(),
]

// Embeddings fallback: OpenAI primary, Together AI as backup when OpenAI is
// down/rate-limited/out of quota. DeepSeek/Kimi/Anthropic don't have a
// working embeddings API (see their embeddings() stubs).
//
// WARNING: these two produce different vector dimensions (OpenAI
// text-embedding-3-small = 1536, Together BAAI/bge-base-en-v1.5 = 768).
// Fine for one-off /api/ai/embed calls, but if this ever feeds a shared
// similarity index, falling over mid-stream would silently corrupt it -
// the response always reports which provider/model actually ran.
const EMBEDDINGS_ORDER = ['openai', 'together']
const EMBEDDINGS_MODELS: Record<string, { model: string; costPerMillionInput: number }> = {
  openai: { model: 'text-embedding-3-small', costPerMillionInput: 0.02 },
  together: { model: 'BAAI/bge-base-en-v1.5', costPerMillionInput: 0.008 },
}

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

  async embeddings(text: string): Promise<{ embedding: number[]; provider: string; model: string }> {
    const requestId = randomUUID()
    const providers = this.allProviders
      .filter((p) => EMBEDDINGS_ORDER.includes(p.name) && p.isAvailable())
      .sort((a, b) => EMBEDDINGS_ORDER.indexOf(a.name) - EMBEDDINGS_ORDER.indexOf(b.name))

    if (providers.length === 0) {
      throw new Error('No embeddings provider configured - set OPENAI_API_KEY or TOGETHER_API_KEY')
    }

    const errors: string[] = []
    for (const provider of providers) {
      const { model, costPerMillionInput } = EMBEDDINGS_MODELS[provider.name]
      try {
        const { embedding, usage } = await provider.embeddings(text)
        const inputTokens = usage?.prompt_tokens ?? Math.ceil(text.length / 4)
        const costUsd = (inputTokens * costPerMillionInput) / 1_000_000

        await this.logUsage({
          requestId,
          provider: provider.name,
          model,
          endpoint: 'embed',
          inputTokens,
          outputTokens: 0,
          costUsd,
          status: 'success',
        })
        return { embedding, provider: provider.name, model }
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
        errors.push(`${provider.name}: ${error.message}`)
      }
    }

    throw new Error(`All embedding providers failed: ${errors.join('; ')}`)
  }

  getAvailableProviders() {
    return this.allProviders.map((p) => ({ name: p.name, available: p.isAvailable() }))
  }

  getStatus() {
    return {
      mode: this.mode,
      order: CHAT_MODE_ORDERS[this.mode],
      embeddingsOrder: EMBEDDINGS_ORDER,
      providers: this.getAvailableProviders(),
    }
  }
}

export const aiClient = new AIClient()

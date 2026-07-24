import { DeepSeekProvider } from './providers/deepseek'
import { KimiProvider } from './providers/kimi'
import { OpenAIProvider } from './providers/openai'
import { AnthropicProvider } from './providers/anthropic'

export interface AIProvider {
  name: string
  chat(messages: any[], options?: any): Promise<any>
  embeddings(text: string): Promise<number[]>
  isAvailable(): boolean
  getCostEstimate(inputTokens: number, outputTokens: number): number
}

export type AIMode = 'launch' | 'scale'

// launch = quality-first (Anthropic primary) for the pre-scale phase.
// scale = cost-first (DeepSeek primary) once volume makes per-call cost matter.
const MODE_ORDERS: Record<AIMode, string[]> = {
  launch: ['anthropic', 'openai', 'kimi', 'deepseek'],
  scale: ['deepseek', 'openai', 'kimi', 'anthropic'],
}

const ALL_PROVIDERS: AIProvider[] = [
  new AnthropicProvider(),
  new OpenAIProvider(),
  new KimiProvider(),
  new DeepSeekProvider(),
]

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

  private orderedAvailableProviders(): AIProvider[] {
    const order =
      process.env.AI_FALLBACK_ORDER?.split(',').map((s) => s.trim()).filter(Boolean) ??
      MODE_ORDERS[this.mode]

    return this.allProviders
      .filter((p) => p.isAvailable())
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
  }

  async chat(options: { messages: any[]; model?: string; temperature?: number }) {
    const { messages, model = 'auto', temperature = 0.7 } = options
    const providers = this.orderedAvailableProviders()

    if (providers.length === 0) {
      throw new Error('No AI providers configured - set at least one *_API_KEY env var')
    }

    if (model !== 'auto') {
      const provider = providers.find((p) => p.name === model)
      if (!provider) throw new Error(`Provider ${model} not available`)
      return provider.chat(messages, { temperature })
    }

    const errors: string[] = []
    for (const provider of providers) {
      try {
        console.log(`[AI] Trying ${provider.name}...`)
        const result = await provider.chat(messages, { temperature })
        console.log(`[AI] Success with ${provider.name}`)
        return result
      } catch (error: any) {
        console.error(`[AI] ${provider.name} failed: ${error.message}`)
        errors.push(`${provider.name}: ${error.message}`)
      }
    }

    throw new Error(`All AI providers failed: ${errors.join('; ')}`)
  }

  async embeddings(text: string, preferredProvider?: string) {
    const providers = this.orderedAvailableProviders()

    if (preferredProvider) {
      const idx = providers.findIndex((p) => p.name === preferredProvider)
      if (idx > 0) {
        const [provider] = providers.splice(idx, 1)
        providers.unshift(provider)
      }
    }

    const errors: string[] = []
    for (const provider of providers) {
      try {
        return await provider.embeddings(text)
      } catch (error: any) {
        console.error(`[AI] ${provider.name} embeddings failed: ${error.message}`)
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
      order: MODE_ORDERS[this.mode],
      providers: this.getAvailableProviders(),
    }
  }
}

export const aiClient = new AIClient()

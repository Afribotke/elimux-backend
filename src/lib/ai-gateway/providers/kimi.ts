import OpenAI from 'openai'
import type { AIProvider } from '../index'

export class KimiProvider implements AIProvider {
  name = 'kimi'
  private client: OpenAI | null = null

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.KIMI_API_KEY
      if (!apiKey) throw new Error('KIMI_API_KEY not set')
      // Moonshot AI (Kimi) exposes an OpenAI-compatible API. If your account
      // uses the international moonshot.ai endpoint instead of moonshot.cn,
      // override via KIMI_BASE_URL.
      this.client = new OpenAI({
        apiKey,
        baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
      })
    }
    return this.client
  }

  isAvailable(): boolean {
    return !!process.env.KIMI_API_KEY
  }

  async chat(messages: any[], options: any = {}) {
    const client = this.getClient()
    const response = await client.chat.completions.create({
      model: 'moonshot-v1-8k',
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2000,
    })
    return {
      content: response.choices[0].message.content,
      provider: this.name,
      model: response.model,
      usage: response.usage,
    }
  }

  async embeddings(_text: string): Promise<{ embedding: number[]; usage?: any }> {
    // Kimi/Moonshot does not publish an embeddings endpoint. Embeddings are
    // OpenAI-only (see AIClient.embeddings).
    throw new Error('Kimi does not support embeddings')
  }

  getCostEstimate(inputTokens: number, outputTokens: number): number {
    // Rough estimate for moonshot-v1-8k - verify against current Moonshot pricing
    return (inputTokens * 0.12 + outputTokens * 0.12) / 1_000_000
  }
}

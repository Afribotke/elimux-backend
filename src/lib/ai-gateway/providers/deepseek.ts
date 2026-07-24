import OpenAI from 'openai'
import type { AIProvider } from '../index'

export class DeepSeekProvider implements AIProvider {
  name = 'deepseek'
  private client: OpenAI | null = null

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.DEEPSEEK_API_KEY
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set')
      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com/v1',
      })
    }
    return this.client
  }

  isAvailable(): boolean {
    return !!process.env.DEEPSEEK_API_KEY
  }

  async chat(messages: any[], options: any = {}) {
    const client = this.getClient()
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
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
    // Confirmed live 2026-07-24: `deepseek-embedding` returns a real 404 -
    // DeepSeek does not publish an embeddings endpoint. Embeddings are
    // OpenAI-only (see AIClient.embeddings) - this always fails over.
    throw new Error('DeepSeek does not support embeddings')
  }

  getCostEstimate(inputTokens: number, outputTokens: number): number {
    return (inputTokens * 0.14 + outputTokens * 0.28) / 1_000_000
  }
}

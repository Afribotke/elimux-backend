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
      // 'deepseek-chat' is no longer in DeepSeek's own /v1/models listing as
      // of 2026-07-24 (confirmed live) - v4-flash is their current cheap/fast
      // tier and what "DeepSeek as the cheapest option" is meant to mean here.
      model: 'deepseek-v4-flash',
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
    // deepseek-v4-flash cache-miss pricing, confirmed 2026-07-24: $0.14/1M in, $0.28/1M out.
    // (Cache-hit input is far cheaper at $0.0028/1M but we don't track cache
    // status here, so this estimate is worst-case/cache-miss.)
    return (inputTokens * 0.14 + outputTokens * 0.28) / 1_000_000
  }
}

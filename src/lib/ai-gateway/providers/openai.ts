import OpenAI from 'openai'
import type { AIProvider } from '../index'

export class OpenAIProvider implements AIProvider {
  name = 'openai'
  private client: OpenAI | null = null

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey) throw new Error('OPENAI_API_KEY not set')
      this.client = new OpenAI({ apiKey })
    }
    return this.client
  }

  isAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY
  }

  async chat(messages: any[], options: any = {}) {
    const client = this.getClient()
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
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

  async embeddings(text: string): Promise<{ embedding: number[]; usage?: any }> {
    // Same model routes/search.ts already uses for semantic search - keeping
    // this consistent means embeddings produced via either path are
    // comparable/interchangeable in the vector index.
    const client = this.getClient()
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    })
    return { embedding: response.data[0].embedding, usage: response.usage }
  }

  getCostEstimate(inputTokens: number, outputTokens: number): number {
    // gpt-4o-mini pricing (approximate, verify against current OpenAI pricing)
    return (inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000
  }
}

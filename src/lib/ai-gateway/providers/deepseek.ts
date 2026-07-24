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

  async embeddings(text: string) {
    // DeepSeek does not currently publish an embeddings endpoint - this call
    // is expected to fail and the AIClient falls back to the next provider
    // (OpenAI, per AI_MODE ordering) rather than treating it as fatal.
    const client = this.getClient()
    const response = await client.embeddings.create({
      model: 'deepseek-embedding',
      input: text,
    })
    return response.data[0].embedding
  }

  getCostEstimate(inputTokens: number, outputTokens: number): number {
    return (inputTokens * 0.14 + outputTokens * 0.28) / 1_000_000
  }
}

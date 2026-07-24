import OpenAI from 'openai'
import type { AIProvider } from '../index'

// Embeddings-focused: Together AI has an OpenAI-compatible API and a cheap,
// reliable embeddings endpoint - added as a fallback for when OpenAI is
// unavailable (rate-limited, no quota, etc). Not part of CHAT_MODE_ORDERS -
// chat() exists only to satisfy the AIProvider interface and as an explicit
// model: 'together' override if ever needed.
//
// IMPORTANT: BAAI/bge-base-en-v1.5 produces 768-dimension vectors, not
// OpenAI's 1536. If embeddings from this gateway are ever persisted into a
// shared vector column (e.g. for similarity search), mixing providers will
// break comparisons - the /api/ai/embed response includes which
// provider/model actually ran so callers can detect this.
export class TogetherProvider implements AIProvider {
  name = 'together'
  private client: OpenAI | null = null

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.TOGETHER_API_KEY
      if (!apiKey) throw new Error('TOGETHER_API_KEY not set')
      this.client = new OpenAI({ apiKey, baseURL: 'https://api.together.xyz/v1' })
    }
    return this.client
  }

  isAvailable(): boolean {
    return !!process.env.TOGETHER_API_KEY
  }

  async chat(messages: any[], options: any = {}) {
    const client = this.getClient()
    const response = await client.chat.completions.create({
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
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
    const client = this.getClient()
    const response = await client.embeddings.create({
      model: 'BAAI/bge-base-en-v1.5',
      input: text,
    })
    return { embedding: response.data[0].embedding, usage: response.usage }
  }

  getCostEstimate(inputTokens: number, outputTokens: number): number {
    // Llama-3.3-70B-Instruct-Turbo pricing (approximate, verify against
    // current Together AI pricing) - not used for chat by default.
    return (inputTokens * 0.88 + outputTokens * 0.88) / 1_000_000
  }
}

import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider } from '../index'

export class AnthropicProvider implements AIProvider {
  name = 'anthropic'
  private client: Anthropic | null = null

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
      this.client = new Anthropic({ apiKey })
    }
    return this.client
  }

  isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY
  }

  async chat(messages: any[], options: any = {}) {
    const client = this.getClient()

    // Anthropic separates the system prompt from the message list.
    const systemMessage = messages.find((m) => m.role === 'system')?.content
    const conversation = messages.filter((m) => m.role !== 'system')

    const response = await client.messages.create({
      model: 'claude-opus-4-8', // matches the model already used in lib/ai/providers/anthropic.ts
      max_tokens: options.maxTokens ?? 2000,
      // claude-opus-4-8 rejects `temperature` outright ("deprecated for this
      // model") - lib/ai/providers/anthropic.ts never sends it either.
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: conversation,
    })

    const textBlock = response.content.find((block) => block.type === 'text')

    return {
      content: textBlock && 'text' in textBlock ? textBlock.text : '',
      provider: this.name,
      model: response.model,
      usage: response.usage,
    }
  }

  async embeddings(_text: string): Promise<{ embedding: number[]; usage?: any }> {
    // Anthropic does not offer an embeddings API. Embeddings are OpenAI-only
    // (see AIClient.embeddings).
    throw new Error('Anthropic does not support embeddings')
  }

  getCostEstimate(inputTokens: number, outputTokens: number): number {
    // claude-opus-4-8 pricing (approximate, verify against current Anthropic pricing)
    return (inputTokens * 15 + outputTokens * 75) / 1_000_000
  }
}

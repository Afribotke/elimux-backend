import { anthropicProvider } from './providers/anthropic'
import type { AIProvider } from './types'

// Swap providers here later (e.g. openaiProvider, geminiProvider) - every
// call site depends only on the AIProvider interface, not on this choice.
export const aiProvider: AIProvider = anthropicProvider

export type { SearchIntent, AIProvider } from './types'

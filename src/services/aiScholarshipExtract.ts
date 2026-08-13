import { aiProvider } from '../lib/ai'

export async function extractScholarshipsFromText(text: string): Promise<any> {
  return aiProvider.extractScholarships(text)
}

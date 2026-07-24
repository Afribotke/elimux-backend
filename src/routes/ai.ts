import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'
import { aiClient } from '../lib/ai-gateway'

const router = Router()

// All routes here are admin-key protected. This gateway proxies paid,
// per-token LLM calls - leaving it public would let anyone run up the
// DeepSeek/OpenAI/Kimi/Anthropic bill for free. If a public-facing feature
// (e.g. a visitor-facing chatbot) needs this later, add a separate
// rate-limited route rather than opening this one up.

// GET /api/ai/status - current mode, fallback order, which providers have keys configured
router.get('/status', adminMiddleware, (req, res) => {
  res.json(aiClient.getStatus())
})

// POST /api/ai/mode - { mode: 'launch' | 'scale' }
router.post('/mode', adminMiddleware, (req, res) => {
  try {
    const { mode } = req.body
    const newMode = aiClient.setMode(mode)
    res.json({ mode: newMode, message: `AI mode set to ${newMode}` })
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
})

// POST /api/ai/chat - { messages: [{role, content}], model?: 'auto' | providerName, temperature? }
router.post('/chat', adminMiddleware, async (req, res) => {
  try {
    const { messages, model, temperature } = req.body

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' })
    }

    const result = await aiClient.chat({ messages, model, temperature })
    res.json(result)
  } catch (error: any) {
    console.error('AI chat error:', error)
    res.status(502).json({ error: error.message || 'AI chat failed' })
  }
})

// POST /api/ai/embed - { text: string, provider?: providerName }
router.post('/embed', adminMiddleware, async (req, res) => {
  try {
    const { text, provider } = req.body

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' })
    }

    const embedding = await aiClient.embeddings(text, provider)
    res.json({ embedding })
  } catch (error: any) {
    console.error('AI embed error:', error)
    res.status(502).json({ error: error.message || 'AI embed failed' })
  }
})

export default router

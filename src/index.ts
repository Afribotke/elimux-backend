import dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'

import institutionsRouter from './routes/institutions'
import programsRouter from './routes/programs'
import paymentsRouter from './routes/payments'
import aiSearchRouter from './routes/ai-search'
import favoritesRouter from './routes/favorites'
import shareRouter from './routes/share'

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API Routes
app.use('/api/institutions', institutionsRouter)
app.use('/api/programs', programsRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/ai-search', aiSearchRouter)
app.use('/api/favorites', favoritesRouter)
app.use('/api/share', shareRouter)

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'ElimuX API',
    version: '1.0.0',
    endpoints: [
      '/health',
      '/api/institutions',
      '/api/programs',
      '/api/payments',
      '/api/ai-search',
      '/api/favorites',
      '/api/share'
    ]
  })
})

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ElimuX API server running on port ${PORT}`)
  })
}

export default app

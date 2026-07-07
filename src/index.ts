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

app.use(cors())
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/institutions', institutionsRouter)
app.use('/api/programs', programsRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/ai-search', aiSearchRouter)
app.use('/api/favorites', favoritesRouter)
app.use('/api/share', shareRouter)

app.get('/', (req, res) => {
  res.json({
    name: 'ElimuX API',
    version: '1.0.0',
    endpoints: ['/health', '/api/institutions', '/api/programs', '/api/payments', '/api/ai-search', '/api/favorites', '/api/share']
  })
})

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path })
})

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ElimuX API server running on port ${PORT}`)
  })
}

export default app

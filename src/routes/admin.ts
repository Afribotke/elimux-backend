import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'

const router = Router()

// GET /api/admin/verify - lightweight key check the frontend's admin gate
// calls before showing the dashboard. Reuses the same check every other
// admin-protected route already applies, so a key that passes here is
// guaranteed to also work for real CRUD operations (and vice versa).
router.get('/verify', adminMiddleware, (req, res) => {
  res.json({ valid: true })
})

export default router

import { Router } from 'express';
const router = Router();

router.post('/create-session', async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe not configured', message: 'Add STRIPE_SECRET_KEY in Railway dashboard' });
  }
  return res.status(501).json({ error: 'Not implemented', message: 'Stripe integration in development' });
});

export default router;

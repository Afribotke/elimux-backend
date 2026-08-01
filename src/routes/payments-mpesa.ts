import { Router } from 'express';
const router = Router();

router.post('/stk-push', async (req, res) => {
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET) {
    return res.status(503).json({ error: 'M-Pesa not configured', message: 'Add MPESA keys in Railway dashboard' });
  }
  return res.status(501).json({ error: 'Not implemented', message: 'M-Pesa integration in development' });
});

export default router;

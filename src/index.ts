import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
dotenv.config()

import express from 'express'
import cors from 'cors'
import { adminRateLimiter } from './middleware/rate-limit'

import institutionsRouter from './routes/institutions'
import programsRouter from './routes/programs'
import paymentsRouter from './routes/payments'
import aiSearchRouter from './routes/ai-search'
import favoritesRouter from './routes/favorites'
import shareRouter from './routes/share'
import reviewsRouter from './routes/reviews'
import adminRouter from './routes/admin'
import adminDashboardRouter from './routes/admin-dashboard'
import adminStudentAssignmentsRoutes from './routes/admin-student-assignments';
import studentTradeTestRoutes from './routes/student-trade-test';
import employerEvaluationsRoutes from './routes/employer-evaluations';
import gamificationRouter from './routes/gamification'
import sponsorAdsRouter from './routes/sponsor-ads'
import adminAnalyticsRouter from './routes/admin-analytics'
import adminReportsRoutes from './routes/admin-reports';
import adminEmployerOutreachRoutes from './routes/admin-employer-outreach';
import searchAnalyticsRouter from './routes/search-analytics'
import pwaRouter from './routes/pwa'
import scraperRouter from './routes/scraper'
import adminScraperScholarshipsRouter from './routes/admin-scraper-scholarships'
import scholarshipMatchingRouter from './routes/scholarship-matching'
import scholarshipApplicationsRouter from './routes/scholarship-applications'
import scholarshipsRouter from './routes/scholarships'
import adminScholarshipsRouter from './routes/admin-scholarships'
import adminScholarshipSponsorsRouter from './routes/admin-scholarship-sponsors'
import adminScholarshipApplicationsRouter from './routes/admin-scholarship-applications'
import adminScholarshipRemindersRouter from './routes/admin-scholarship-reminders'
import scholarshipProvidersRouter from './routes/scholarship-providers'
import cronScholarshipRemindersRouter from './routes/cron-scholarship-reminders'
import accreditationBodiesRouter from './routes/accreditation-bodies'
import majorSponsorRouter from './routes/major-sponsor'
import advertiserRouter from './routes/advertiser'
import advertiserPaymentsRouter from './routes/advertiser-payments'
import campaignsRouter from './routes/campaigns'
import adsRouter from './routes/ads'
import configRouter from './routes/config'
import adminSettingsRouter from './routes/admin-settings'
import adminPaymentsRouter from './routes/admin-payments'
import institutionPortal from './routes/institution-portal'
import partnersRouter from './routes/partners'
import referralsRouter from './routes/referrals'
import selfServeAdsRouter from './routes/self-serve-ads'
import authRouter from './routes/auth'
import searchRouter from './routes/search'
import contactRouter from './routes/contact'
import aiRouter from './routes/ai'
import applicationsRouter from './routes/applications'
import internshipsRouter from './routes/internships'
import employerNamesRouter from './routes/employer-names'
import adminEmployerNamesRouter from './routes/admin-employer-names'
import tvetaRouter from './routes/tveta'
import attachmentsRouter from './routes/attachments'
import nitaRouter from './routes/nita'
import requisitionsRouter from './routes/requisitions'
import userExportRouter from './routes/user-export'
import userDeleteRouter from './routes/user-delete'
import bursaryPaymentsRouter from './routes/bursary-payments'
import { supabaseConfigOk, supabaseKeyRole } from './lib/supabase'
import stripePayments from './routes/payments-stripe';
import mpesaPayments from './routes/payments-mpesa';
import helmet from 'helmet'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'] }))
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://*.supabase.co", "https://api.elimux.ke"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Not in the original spec, added deliberately: helmet's default
  // Cross-Origin-Resource-Policy is 'same-origin', which is a different
  // mechanism from CORS (the cors() call above only controls XHR/fetch
  // access, not <img>/<script>-style cross-origin embedding) and a common
  // source of "images/assets silently stopped loading cross-origin" bugs
  // after adding helmet. This API is meant to be consumed cross-origin from
  // elimux-frontend and any other client, so explicitly opt out.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}))
app.use(
  // 8mb, not 5mb: scholarship-applications.ts uploads send files as base64
  // inside this JSON body, which inflates a file at documentUpload.ts's own
  // 5MB cap to ~6.65MB of JSON. This is the app-wide parser (mounted before
  // any router), so a route-local override can't apply - a request that
  // exceeds this limit never reaches any route handler.
  express.json({ limit: '8mb',
    verify: (req, _res, buf) => {
      ;(req as any).rawBody = buf
    },
  })
)

// `status` stays a pure liveness signal (and always HTTP 200) so Railway's
// healthcheck and any uptime monitor keep behaving as before. Configuration
// problems are reported alongside it rather than by failing the check.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    supabase: { configured: supabaseConfigOk, key_role: supabaseKeyRole },
  })
})

app.use('/api/institutions', institutionsRouter)
app.use('/api/programs', programsRouter)
app.use('/api/payments', paymentsRouter)
app.use('/api/ai-search', aiSearchRouter)
app.use('/api/favorites', favoritesRouter)
app.use('/api/share', shareRouter)
app.use('/api/reviews', reviewsRouter)
app.use('/api/admin', adminRateLimiter)
app.use('/api/admin', adminRouter)
app.use('/api/admin/dashboard', adminDashboardRouter)
app.use('/api/admin/student-assignments', adminStudentAssignmentsRoutes);
app.use('/api/student/trade-test', studentTradeTestRoutes);
app.use('/api/employer/evaluations', employerEvaluationsRoutes);
app.use('/api/admin/analytics', adminAnalyticsRouter)
app.use('/api/admin/reports', adminReportsRoutes);
app.use('/api/admin/employer-outreach', adminEmployerOutreachRoutes);
app.use('/api/analytics', searchAnalyticsRouter)
app.use('/api/gamification', gamificationRouter)
app.use('/api/sponsor-ads', sponsorAdsRouter)
app.use('/api/pwa', pwaRouter)
app.use('/api/admin/scraper', scraperRouter)
app.use('/api/admin/scraper', adminScraperScholarshipsRouter)
// Mounted before scholarshipsRouter so /match and /match/me can never be
// shadowed by its GET /:id catch-all.
app.use('/api/scholarships', scholarshipMatchingRouter)
app.use('/api/scholarships', scholarshipsRouter)
// Not /api/applications - that's already the internship-applications router.
app.use('/api/scholarship-applications', scholarshipApplicationsRouter)
app.use('/api/admin/scholarships', adminScholarshipsRouter)
app.use('/api/admin/scholarship-sponsors', adminScholarshipSponsorsRouter)
app.use('/api/admin/scholarship-applications', adminScholarshipApplicationsRouter)
app.use('/api/admin/scholarship-applications', adminScholarshipRemindersRouter)
app.use('/api/scholarship-providers', scholarshipProvidersRouter)
app.use('/api/cron/scholarship-reminders', cronScholarshipRemindersRouter)
app.use('/api/accreditation-bodies', accreditationBodiesRouter)
app.use('/api/major-sponsor', majorSponsorRouter)
app.use('/api/advertiser', advertiserRouter)
app.use('/api/advertiser/payments', advertiserPaymentsRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/ads', adsRouter)
app.use('/api/config', configRouter)
app.use('/api/admin/settings', adminSettingsRouter)
app.use('/api/admin/payments', adminPaymentsRouter)
app.use('/api/institution-portal', institutionPortal)
app.use('/api/partners', partnersRouter)
app.use('/api/referrals', referralsRouter)
app.use('/api/self-serve-ads', selfServeAdsRouter)
app.use('/api/auth', authRouter)
app.use('/api/search', searchRouter)
app.use('/api/contact', contactRouter)
app.use('/api/ai', aiRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api', internshipsRouter)
app.use('/api/employer-names', employerNamesRouter)
app.use('/api/admin/employer-names', adminEmployerNamesRouter)
app.use('/api/tveta', tvetaRouter)
app.use('/api/attachments', attachmentsRouter)
app.use('/api/nita', nitaRouter)
app.use('/api/requisitions', requisitionsRouter)
app.use('/api/user', userExportRouter)
app.use('/api/user', userDeleteRouter)
app.use('/api/bursary/payments', bursaryPaymentsRouter)

app.get('/', (req, res) => {
  res.json({
    name: 'ElimuX API',
    version: '1.0.0',
    endpoints: ['/health', '/api/institutions', '/api/programs', '/api/payments', '/api/ai-search', '/api/favorites', '/api/share', '/api/reviews', '/api/admin', '/api/admin/dashboard', '/api/admin/analytics', '/api/analytics', '/api/gamification', '/api/sponsor-ads', '/api/pwa', '/api/admin/scraper', '/api/scholarships', '/api/accreditation-bodies', '/api/major-sponsor', '/api/advertiser', '/api/advertiser/payments', '/api/campaigns', '/api/ads', '/api/institution-portal', '/api/tveta']
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

app.use('/api/payments/stripe', stripePayments);
app.use('/api/payments/mpesa', mpesaPayments);

export default app



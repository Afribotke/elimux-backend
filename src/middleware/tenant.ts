import { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      tenantId?: string | null;
    }
  }
}

export function resolveTenant(req: Request, res: Response, next: NextFunction) {
  // Phase 1: header-based tenant resolution
  // Future: subdomain-based resolution from Host header
  const tenantId = req.headers['x-tenant-id'] as string;
  req.tenantId = tenantId || null;
  next();
}

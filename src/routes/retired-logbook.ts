import { Request, Response } from 'express'

/**
 * L-04: handler for the retired /students/logbook and /students/me/logbook
 * routes. Touches no database and reveals nothing about the caller.
 */
export const LOGBOOK_RETIRED_BODY = {
  success: false,
  error: 'This endpoint has been retired. Use /api/attachments/:id/logbook.',
} as const

export function logbookRetired(_req: Request, res: Response): void {
  res.status(410).json(LOGBOOK_RETIRED_BODY)
}

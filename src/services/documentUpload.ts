import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
]

const MAX_SIZE_MB = 5

export interface UploadResult {
  path: string
  url: string
  filename: string
  size: number
}

/**
 * Upload a scholarship document to the private scholarship-documents bucket.
 * Files are stored as {userId}/{applicationId}/{filename}, matching that
 * bucket's RLS policy (see elimux-sql/41_scholarship_documents_bucket.sql).
 */
export async function uploadScholarshipDocument(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  size: number,
  userId: string,
  applicationId: string
): Promise<UploadResult> {
  if (!ALLOWED_TYPES.includes(mimeType)) {
    throw new Error(`Invalid file type: ${mimeType}. Allowed: PDF, JPEG, PNG`)
  }

  if (size > MAX_SIZE_MB * 1024 * 1024) {
    throw new Error(`File too large: ${(size / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_SIZE_MB}MB`)
  }

  const sanitized = originalName
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .toLowerCase()

  const timestamp = Date.now()
  const filename = `${timestamp}_${sanitized}`
  const path = `${userId}/${applicationId}/${filename}`

  const { data, error } = await supabase.storage
    .from('scholarship-documents')
    .upload(path, fileBuffer, {
      contentType: mimeType,
      upsert: false,
    })

  if (error) throw new Error(`Upload failed: ${error.message}`)

  // Signed URL, not a public one — the bucket is private.
  const { data: urlData } = await supabase.storage
    .from('scholarship-documents')
    .createSignedUrl(path, 3600)

  return {
    path: data.path,
    url: urlData?.signedUrl || '',
    filename: originalName,
    size,
  }
}

export async function deleteScholarshipDocument(path: string): Promise<void> {
  const { error } = await supabase.storage
    .from('scholarship-documents')
    .remove([path])

  if (error) throw new Error(`Delete failed: ${error.message}`)
}

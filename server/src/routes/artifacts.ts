import { Router } from 'express'
import { pipeline } from 'stream/promises'
import { Types } from 'mongoose'
import { asyncHandler, HttpError } from '../http/problem'
import { requireOrganizationId } from '../types/authenticatedRequest'
import { openArtifact, safeDownloadFileName } from '../services/artifactStore'
import { recordAudit } from '../services/audit'

const router = Router()

router.get('/:id/download', asyncHandler(async (req, res) => {
  const artifactId = String(req.params.id || '')
  if (!Types.ObjectId.isValid(artifactId)) throw new HttpError(400, 'Invalid artifact', 'Artifact identifier is invalid')
  const organizationId = requireOrganizationId(req)
  const { artifact, stream } = await openArtifact(organizationId, artifactId)
  const fileName = safeDownloadFileName(artifact.fileName)
  res.status(200)
  res.setHeader('Content-Type', artifact.contentType)
  res.setHeader('Content-Length', String(artifact.plaintextSize))
  res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
  res.setHeader('Cache-Control', 'private, no-store')
  await recordAudit({ action: 'artifact.downloaded', req, entityType: 'Artifact', entityId: String(artifact._id), metadata: { kind: artifact.kind } })
  await pipeline(stream, res)
}))

export default router

import crypto from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { chmod, mkdir, mkdtemp, open, rm, stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import Artifact, { ArtifactKind } from '../models/Artifact'
import { env } from '../env'

type StoredObject = { stream: Readable }

interface ArtifactStorageBackend {
  readonly driver: 'local' | 's3'
  putFile(storageKey: string, sourcePath: string): Promise<void>
  get(storageKey: string): Promise<StoredObject>
  delete(storageKey: string): Promise<void>
}

function normalizedFileName(input: string): string {
  const leaf = path.basename(String(input || 'artifact.bin')).normalize('NFKC')
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim().slice(0, 180)
  return cleaned || 'artifact.bin'
}

function storageKeyFor(organizationId: string, artifactId: string): string {
  if (!/^[a-f0-9]{24}$/i.test(organizationId) || !/^[a-f0-9]{24}$/i.test(artifactId)) {
    throw new Error('Artifact storage identifiers are invalid')
  }
  return `${organizationId}/${artifactId}/${crypto.randomBytes(12).toString('hex')}.lfenc`
}

function artifactAad(organizationId: string, artifactId: string, kind: ArtifactKind): Buffer {
  return Buffer.from(`artifact:${organizationId}:${artifactId}:${kind}`, 'utf8')
}

function localObjectPath(root: string, storageKey: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, storageKey)
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Unsafe artifact storage key')
  return resolved
}

class LocalArtifactBackend implements ArtifactStorageBackend {
  readonly driver = 'local' as const

  async putFile(storageKey: string, sourcePath: string): Promise<void> {
    const destination = localObjectPath(env.ARTIFACT_LOCAL_ROOT, storageKey)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await pipeline(createReadStream(sourcePath), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    await chmod(destination, 0o600)
  }

  async get(storageKey: string): Promise<StoredObject> {
    const source = localObjectPath(env.ARTIFACT_LOCAL_ROOT, storageKey)
    return { stream: createReadStream(source) }
  }

  async delete(storageKey: string): Promise<void> {
    await rm(localObjectPath(env.ARTIFACT_LOCAL_ROOT, storageKey), { force: true })
  }
}

let s3Client: S3Client | undefined

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: env.ARTIFACT_S3_REGION,
      endpoint: env.ARTIFACT_S3_ENDPOINT,
      forcePathStyle: env.ARTIFACT_S3_FORCE_PATH_STYLE,
    })
  }
  return s3Client
}

class S3ArtifactBackend implements ArtifactStorageBackend {
  readonly driver = 's3' as const

  async putFile(storageKey: string, sourcePath: string): Promise<void> {
    const sourceStats = await stat(sourcePath)
    await getS3Client().send(new PutObjectCommand({
      Bucket: env.ARTIFACT_S3_BUCKET,
      Key: storageKey,
      Body: createReadStream(sourcePath),
      ContentLength: sourceStats.size,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: env.ARTIFACT_S3_KMS_KEY_ID ? 'aws:kms' : 'AES256',
      SSEKMSKeyId: env.ARTIFACT_S3_KMS_KEY_ID,
    }))
  }

  async get(storageKey: string): Promise<StoredObject> {
    const response = await getS3Client().send(new GetObjectCommand({ Bucket: env.ARTIFACT_S3_BUCKET, Key: storageKey }))
    if (!response.Body) throw new Error('Artifact object has no response body')
    const body = response.Body as any
    if (body instanceof Readable) return { stream: body }
    if (typeof body.transformToWebStream === 'function') return { stream: Readable.fromWeb(body.transformToWebStream()) }
    throw new Error('Artifact object body cannot be streamed')
  }


  async delete(storageKey: string): Promise<void> {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: env.ARTIFACT_S3_BUCKET, Key: storageKey }))
  }
}

function backend(): ArtifactStorageBackend {
  return env.ARTIFACT_STORAGE_DRIVER === 's3' ? new S3ArtifactBackend() : new LocalArtifactBackend()
}

async function encryptFile(inputPath: string, outputPath: string, aad: Buffer): Promise<{ iv: string; tag: string; sha256: string; size: number }> {
  const inputStats = await stat(inputPath)
  if (!inputStats.isFile()) throw new Error('Artifact source must be a regular file')
  if (inputStats.size > env.ARTIFACT_MAX_BYTES) throw new Error(`Artifact exceeds the ${env.ARTIFACT_MAX_BYTES} byte limit`)

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.ENCRYPTION_KEY, 'hex'), iv)
  cipher.setAAD(aad)
  const hash = crypto.createHash('sha256')
  let size = 0
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(createReadStream(inputPath), hasher, cipher, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }))
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    sha256: hash.digest('hex'),
    size,
  }
}

export async function storeArtifactFromFile(input: {
  organizationId: string
  kind: ArtifactKind
  sourcePath: string
  fileName: string
  contentType: string
  createdBy?: string
  metadata?: Record<string, unknown>
  expiresAt?: Date
}) {
  const selectedBackend = backend()
  const row: any = new Artifact({
    organizationId: input.organizationId,
    kind: input.kind,
    storageDriver: selectedBackend.driver,
    storageKey: 'pending',
    fileName: normalizedFileName(input.fileName),
    contentType: String(input.contentType || 'application/octet-stream').slice(0, 160),
    plaintextSize: 0,
    sha256: 'pending',
    encryptionIv: 'pending',
    encryptionTag: 'pending',
    status: 'pending',
    createdBy: input.createdBy,
    metadata: input.metadata || {},
    expiresAt: input.expiresAt,
  })
  row.storageKey = storageKeyFor(input.organizationId, String(row._id))
  await row.save()

  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'logicflower-artifact-'))
  const encryptedPath = path.join(workDirectory, `${row._id}.lfenc`)
  try {
    const encrypted = await encryptFile(input.sourcePath, encryptedPath, artifactAad(input.organizationId, String(row._id), input.kind))
    await selectedBackend.putFile(row.storageKey, encryptedPath)
    row.plaintextSize = encrypted.size
    row.sha256 = encrypted.sha256
    row.encryptionIv = encrypted.iv
    row.encryptionTag = encrypted.tag
    row.status = 'ready'
    await row.save()
    return row
  } catch (error: any) {
    row.status = 'failed'
    row.error = String(error?.message || error).slice(0, 1_000)
    await row.save().catch(() => undefined)
    throw error
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

export async function storeArtifactFromBuffer(input: Omit<Parameters<typeof storeArtifactFromFile>[0], 'sourcePath'> & { body: Buffer | string }) {
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'logicflower-artifact-source-'))
  const sourcePath = path.join(workDirectory, 'source')
  try {
    const handle = await open(sourcePath, 'wx', 0o600)
    try { await handle.writeFile(input.body) } finally { await handle.close() }
    const { body: _body, ...rest } = input
    return await storeArtifactFromFile({ ...rest, sourcePath })
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

export async function openArtifact(organizationId: string, artifactId: string): Promise<{
  artifact: any
  stream: Readable
}> {
  const artifact: any = await Artifact.findOne({ _id: artifactId, organizationId, status: 'ready' })
    .select('+storageKey +encryptionIv +encryptionTag')
  if (!artifact) throw Object.assign(new Error('Artifact not found'), { statusCode: 404, code: 'ARTIFACT_NOT_FOUND' })
  if (artifact.expiresAt && artifact.expiresAt.getTime() <= Date.now()) {
    throw Object.assign(new Error('Artifact has expired'), { statusCode: 410, code: 'ARTIFACT_EXPIRED' })
  }
  if (artifact.encryptionVersion !== 1) throw new Error('Unsupported artifact encryption version')
  const selectedBackend = artifact.storageDriver === 's3' ? new S3ArtifactBackend() : new LocalArtifactBackend()
  const object = await selectedBackend.get(artifact.storageKey)
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    Buffer.from(artifact.encryptionIv, 'base64'),
  )
  decipher.setAAD(artifactAad(organizationId, String(artifact._id), artifact.kind))
  decipher.setAuthTag(Buffer.from(artifact.encryptionTag, 'base64'))
  return { artifact, stream: object.stream.pipe(decipher) }
}

export function safeDownloadFileName(input: string): string {
  return normalizedFileName(input).replace(/[\r\n]/g, '_')
}

export async function deleteStoredArtifact(organizationId: string, artifactId: string): Promise<boolean> {
  const artifact: any = await Artifact.findOne({
    _id: artifactId,
    organizationId,
    status: { $ne: 'deleted' },
  }).select('+storageKey')
  if (!artifact) return false
  if (artifact.storageKey && artifact.storageKey !== 'pending') {
    const selectedBackend = artifact.storageDriver === 's3' ? new S3ArtifactBackend() : new LocalArtifactBackend()
    await selectedBackend.delete(String(artifact.storageKey))
  }
  artifact.status = 'deleted'
  artifact.deletedAt = new Date()
  artifact.storageKey = `deleted/${artifact._id}`
  await artifact.save()
  return true
}

export async function purgeExpiredArtifacts(limit = 100): Promise<number> {
  // tenant-safe: cross-tenant retention worker; selects expired artifacts across all organisations by design
  const rows: any[] = await Artifact.find({
    expiresAt: { $lte: new Date() },
    status: { $in: ['ready', 'failed'] },
  }).sort({ expiresAt: 1 }).limit(Math.max(1, Math.min(500, limit))).select('_id organizationId').lean()
  let deleted = 0
  for (const row of rows) {
    if (await deleteStoredArtifact(String(row.organizationId), String(row._id))) deleted += 1
  }
  return deleted
}

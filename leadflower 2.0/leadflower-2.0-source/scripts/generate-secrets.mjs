import { randomBytes } from 'node:crypto'

const base64url = (length) => randomBytes(length).toString('base64url')

process.stdout.write([
  `JWT_ACCESS_SECRET=${base64url(48)}`,
  `JWT_REFRESH_SECRET=${base64url(48)}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
  '',
].join('\n'))


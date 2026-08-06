import pino from 'pino'
import { env } from './env'

export default pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'request.headers.authorization',
      'config.headers.Authorization', 'config.headers.authorization', 'config.data',
      'password', '*.password', 'token', '*.token', '*.*.token',
      'refreshToken', '*.refreshToken', 'accessToken', '*.accessToken',
      'apiKey', '*.apiKey', 'credentials', '*.credentials', 'encryptedCredentials',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
})

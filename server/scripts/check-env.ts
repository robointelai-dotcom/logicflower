import { corsOrigins, env } from '../src/env'

console.log(JSON.stringify({
  valid: true,
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  appOrigin: new URL(env.APP_URL).origin,
  apiOrigin: new URL(env.API_URL).origin,
  corsOrigins,
  secureCookies: env.COOKIE_SECURE,
  artifactStorage: env.ARTIFACT_STORAGE_DRIVER,
  smtpConfigured: Boolean(env.SMTP_HOST),
  stripeConfigured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  oauthConfigured: {
    ghl: Boolean(env.GHL_CLIENT_ID && env.GHL_CLIENT_SECRET && env.GHL_REDIRECT_URI),
    hubspot: Boolean(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET && env.HUBSPOT_REDIRECT_URI),
    klaviyo: Boolean(env.KLAVIYO_CLIENT_ID && env.KLAVIYO_CLIENT_SECRET && env.KLAVIYO_REDIRECT_URI),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
  },
}, null, 2))

import nodemailer from 'nodemailer'
import { env } from '../env'

let transporter: ReturnType<typeof nodemailer.createTransport> | undefined

function mailer() {
  if (!env.SMTP_HOST) throw new Error('Email delivery is not configured')
  transporter ||= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD || '' } : undefined,
  })
  return transporter
}

function html(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character))
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = new URL('/reset-password', env.APP_URL)
  resetUrl.searchParams.set('token', token)
  await mailer().sendMail({
    from: env.EMAIL_FROM,
    to: email,
    subject: 'Reset your LogicFlower password',
    text: `A password reset was requested for your LogicFlower account. Open this one-time link within 30 minutes: ${resetUrl.toString()}\n\nIf you did not request this, ignore this message.`,
    html: `<p>A password reset was requested for your LogicFlower account.</p><p><a href="${html(resetUrl.toString())}">Reset password</a>. This one-time link expires in 30 minutes.</p><p>If you did not request this, ignore this message.</p>`,
  })
}

export async function sendInvitationEmail(email: string, organizationName: string, token: string): Promise<void> {
  const invitationUrl = new URL('/accept-invitation', env.APP_URL)
  invitationUrl.searchParams.set('token', token)
  await mailer().sendMail({
    from: env.EMAIL_FROM,
    to: email,
    subject: `Invitation to ${organizationName.replace(/[\r\n]/g, ' ')} on LogicFlower`,
    text: `You were invited to ${organizationName} on LogicFlower. Open this one-time link within 7 days: ${invitationUrl.toString()}`,
    html: `<p>You were invited to <strong>${html(organizationName)}</strong> on LogicFlower.</p><p><a href="${html(invitationUrl.toString())}">Accept invitation</a>. This one-time link expires in 7 days.</p>`,
  })
}

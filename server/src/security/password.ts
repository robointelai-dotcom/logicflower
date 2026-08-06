import bcrypt from 'bcryptjs'

const BCRYPT_COST = 12
const PASSWORD_MIN_LENGTH = 12

export function validatePasswordStrength(password: string): string[] {
  const errors: string[] = []
  if (password.length < PASSWORD_MIN_LENGTH) errors.push(`Password must contain at least ${PASSWORD_MIN_LENGTH} characters`)
  if (password.length > 128) errors.push('Password must contain no more than 128 characters')
  if (!/[a-z]/.test(password)) errors.push('Password must contain a lowercase letter')
  if (!/[A-Z]/.test(password)) errors.push('Password must contain an uppercase letter')
  if (!/[0-9]/.test(password)) errors.push('Password must contain a number')
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Password must contain a symbol')
  return errors
}

export async function hashPassword(password: string): Promise<string> {
  const errors = validatePasswordStrength(password)
  if (errors.length) throw new Error(errors[0])
  return bcrypt.hash(password, BCRYPT_COST)
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash)
}

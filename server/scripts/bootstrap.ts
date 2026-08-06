import '../src/loadEnv'
import crypto from 'crypto'
import { connectDB } from '../src/db'
import { env } from '../src/env'
import User from '../src/models/User'
import Organization from '../src/models/Organization'
import Membership from '../src/models/Membership'
import Subscription from '../src/models/Subscription'
import { hashPassword } from '../src/security/password'
import mongoose from 'mongoose'

function hasFlag(flag: string): boolean { return process.argv.includes(flag) }
function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const email = String(argument('--email') || env.BOOTSTRAP_EMAIL || '').trim().toLowerCase()
  const organizationName = String(argument('--organization-name') || 'LogicFlower').trim()
  const password = env.BOOTSTRAP_PASSWORD || ''
  if (!email || !password) throw new Error('Set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD; never pass the password on the command line')
  await connectDB()
  let user: any = await User.findOne({ email }).select('+passwordHash')
  if (!user) {
    user = await User.create({
      email,
      displayName: argument('--name') || 'LogicFlower Owner',
      passwordHash: await hashPassword(password),
      platformRole: hasFlag('--platform-owner') ? 'owner' : 'user',
      emailVerifiedAt: new Date(),
    })
  } else {
    const update: Record<string, unknown> = {}
    if (hasFlag('--reset-password')) update.passwordHash = await hashPassword(password)
    if (hasFlag('--platform-owner')) update.platformRole = 'owner'
    if (Object.keys(update).length) await User.updateOne({ _id: user._id }, { $set: update })
  }

  let organization: any = await Organization.findOne({ createdBy: user._id, name: organizationName })
  if (!organization) {
    const base = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'organization'
    organization = await Organization.create({
      name: organizationName,
      slug: `${base}-${crypto.randomBytes(5).toString('hex')}`,
      createdBy: user._id,
      ownerCount: 1,
    })
  }
  await Membership.findOneAndUpdate({ organizationId: organization._id, userId: user._id }, {
    $set: { role: 'owner', status: 'active', joinedAt: new Date() },
  }, { upsert: true, setDefaultsOnInsert: true })
  const ownerCount = await Membership.countDocuments({ organizationId: organization._id, role: 'owner', status: 'active' })
  await Organization.updateOne({ _id: organization._id }, { $set: { ownerCount: Math.max(1, ownerCount) } })
  await Subscription.updateOne({ organizationId: organization._id }, {
    $setOnInsert: { plan: 'free', status: 'inactive' },
  }, { upsert: true })
  process.stdout.write(`Bootstrap complete for ${email}; organizationId=${String(organization._id)}\n`)
  await mongoose.disconnect()
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Bootstrap failed'}\n`)
  await mongoose.disconnect().catch(() => undefined)
  process.exitCode = 1
})

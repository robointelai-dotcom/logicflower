import '../src/loadEnv'
import crypto from 'crypto'
import { connectDB } from '../src/db'
import User from '../src/models/User'
import Organization from '../src/models/Organization'
import Membership, { membershipRoles } from '../src/models/Membership'
import Subscription from '../src/models/Subscription'
import { hashPassword } from '../src/security/password'
import mongoose from 'mongoose'

async function main() {
  await connectDB()
  
  const organizationName = 'Test Org'
  const base = organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'organization'
  
  let organization: any = await Organization.findOne({ name: organizationName })
  if (!organization) {
    organization = await Organization.create({
      name: organizationName,
      slug: `${base}-${crypto.randomBytes(5).toString('hex')}`,
      createdBy: new mongoose.Types.ObjectId(),
      ownerCount: 1,
    })
  }

  const defaultPassword = 'Password123!'
  const passwordHash = await hashPassword(defaultPassword)

  const rolesToCreate = [
    { type: 'platform', role: 'owner' },
    { type: 'platform', role: 'admin' },
    { type: 'platform', role: 'support' },
    { type: 'platform', role: 'user' },
    ...membershipRoles.map(r => ({ type: 'membership', role: r }))
  ]
  
  for (const r of rolesToCreate) {
    const email = `${r.type}-${r.role}@logicflower.local`
    
    let user: any = await User.findOne({ email })
    if (!user) {
      user = await User.create({
        email,
        displayName: `${r.type} ${r.role}`,
        passwordHash,
        platformRole: r.type === 'platform' ? r.role : 'user',
        emailVerifiedAt: new Date(),
      })
    }
    
    if (r.type === 'membership') {
        await Membership.findOneAndUpdate({ organizationId: organization._id, userId: user._id }, {
            $set: { role: r.role, status: 'active', joinedAt: new Date() },
        }, { upsert: true, setDefaultsOnInsert: true })
    } else {
        await Membership.findOneAndUpdate({ organizationId: organization._id, userId: user._id }, {
            $set: { role: 'viewer', status: 'active', joinedAt: new Date() },
        }, { upsert: true, setDefaultsOnInsert: true })
    }
    
    console.log(`Role: ${r.type} / ${r.role} | Email: ${email} | Password: ${defaultPassword}`)
  }
  
  await mongoose.disconnect()
}

main().catch(console.error)

const { connectDB } = require('./dist/src/db');
const User = require('./dist/src/models/User').default;
const Organization = require('./dist/src/models/Organization').default;
const Membership = require('./dist/src/models/Membership').default;
const { hashPassword } = require('./dist/src/security/password');
const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();

async function main() {
  await connectDB();
  
  const defaultPassword = 'Password123!';
  const passwordHash = await hashPassword(defaultPassword);

  const tiers = [
    { kind: 'corporate', role: 'owner', name: 'Corporate Operator' },
    { kind: 'agency', role: 'agency_owner', name: 'Agency Reseller' },
    { kind: 'client', role: 'owner', name: 'Standard Client' }
  ];

  for (const t of tiers) {
    const email = `${t.kind}-user@logicflower.local`;
    
    // Create Organization
    let organization = await Organization.findOne({ kind: t.kind });
    if (!organization) {
      organization = await Organization.create({
        name: `${t.name} Org`,
        slug: `${t.kind}-${crypto.randomBytes(5).toString('hex')}`,
        createdBy: new mongoose.Types.ObjectId(),
        ownerCount: 1,
        kind: t.kind
      });
    }

    // Create User
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        displayName: t.name,
        passwordHash,
        platformRole: t.kind === 'corporate' ? 'owner' : 'user',
        mfaEnabled: t.kind === 'corporate' ? true : false,
        emailVerifiedAt: new Date(),
      });
    }

    // Assign Membership
    await Membership.findOneAndUpdate(
      { organizationId: organization._id, userId: user._id },
      { $set: { role: t.role, status: 'active', joinedAt: new Date() } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    
    console.log(`Tier: ${t.kind.toUpperCase()} | Role: ${t.role} | Email: ${email} | Password: ${defaultPassword}`);
  }
  
  await mongoose.disconnect();
}

main().catch(console.error);

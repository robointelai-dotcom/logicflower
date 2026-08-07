import Organization from '../models/Organization'

export async function reserveOwnerRemoval(organizationId: string): Promise<boolean> {
  const result = await Organization.updateOne({ _id: organizationId, ownerCount: { $gt: 1 } }, {
    $inc: { ownerCount: -1 },
  })
  return result.modifiedCount === 1
}

export async function addOrganizationOwner(organizationId: string): Promise<void> {
  await Organization.updateOne({ _id: organizationId }, { $inc: { ownerCount: 1 } })
}

export async function compensateOwnerRemoval(organizationId: string): Promise<void> {
  await Organization.updateOne({ _id: organizationId }, { $inc: { ownerCount: 1 } })
}

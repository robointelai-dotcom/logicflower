import Destination from '../models/Destination'
import { decryptJson } from '../security/encryption'

export async function getVerifiedDestination(input: { organizationId: string; destinationId: string }) {
  const destination: any = await Destination.findOne({
    _id: input.destinationId,
    organizationId: input.organizationId,
    status: 'verified',
  }).select('+encryptedConfig')
  if (!destination) throw new Error('Verified destination not found')
  const config = decryptJson<{ url: string; headers: Record<string, string> }>(
    destination.encryptedConfig,
    `destination:${input.organizationId}:${String(destination._id)}`,
  )
  return {
    destinationId: String(destination._id),
    url: config.url,
    hostname: destination.hostname,
    pinnedAddresses: destination.pinnedAddresses || [],
    allowedMethods: destination.allowedMethods || [],
    headers: config.headers,
  }
}

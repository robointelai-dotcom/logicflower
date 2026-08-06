import mongoose, { ClientSession } from 'mongoose'

function transactionsUnsupported(error: any): boolean {
  return error?.code === 20 || /Transaction numbers are only allowed|replica set member or mongos/i.test(String(error?.message || ''))
}

export async function withMongoTransaction<T>(work: (session?: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  let result: T | undefined
  try {
    await session.withTransaction(async () => { result = await work(session) })
    return result as T
  } catch (error) {
    if (!transactionsUnsupported(error)) throw error
    return work(undefined)
  } finally {
    await session.endSession()
  }
}

import mongoose from 'mongoose';
import pino from './logger';
import { env } from './env';

export async function connectDB() {
  mongoose.set('strictQuery', true)
  await mongoose.connect(env.MONGO_URI, {
    autoIndex: env.NODE_ENV !== 'production',
    maxPoolSize: 30,
    minPoolSize: env.NODE_ENV === 'test' ? 0 : 2,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });
  pino.info('[db] connected');
}

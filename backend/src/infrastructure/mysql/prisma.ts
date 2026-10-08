import { PrismaClient } from '@prisma/client';
import { logger } from '../../common/logger/logger.js';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export async function connectPrisma(): Promise<void> {
  await prisma.$connect();
  logger.info('MySQL connected via Prisma');
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

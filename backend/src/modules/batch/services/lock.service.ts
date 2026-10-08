import { randomUUID } from 'node:crypto';
import type { BatchModule } from '@prisma/client';
import { LOCK_KEYS } from '../../../common/constants/index.js';
import { ConflictError } from '../../../common/exceptions/app-error.js';
import { acquireLock, extendLock, releaseLock } from '../../../infrastructure/redis/client.js';

const LOCK_TTL_SECONDS = 60 * 60 * 26; // covers a full IST day plus buffer; workers refresh it

function lockKeyForModule(module: BatchModule): string {
  return module === 'INVOICE_GENERATION'
    ? LOCK_KEYS.INVOICE_GENERATION
    : LOCK_KEYS.INVOICE_CHARGE;
}

export class LockService {
  async acquireModuleLock(module: BatchModule): Promise<string> {
    const key = lockKeyForModule(module);
    const token = randomUUID();
    const ok = await acquireLock(key, LOCK_TTL_SECONDS, token);
    if (!ok) {
      const label =
        module === 'INVOICE_GENERATION' ? 'Invoice Generation' : 'Invoice Charge';
      throw new ConflictError(
        `${label} batch is already running. Please wait until it completes.`,
      );
    }
    return token;
  }

  async releaseModuleLock(module: BatchModule, token: string): Promise<void> {
    await releaseLock(lockKeyForModule(module), token);
  }

  async heartbeat(module: BatchModule, token: string): Promise<void> {
    await extendLock(lockKeyForModule(module), token, LOCK_TTL_SECONDS);
  }
}

export const lockService = new LockService();

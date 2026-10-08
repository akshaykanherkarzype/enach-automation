import { Redis } from 'ioredis';
import { env } from '../../common/config/env.js';
import { logger } from '../../common/logger/logger.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err: Error) => {
  logger.error({ err }, 'Redis error');
});

export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }
  logger.info('Redis connected');
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

/**
 * Distributed lock using SET NX EX.
 * Returns a token that must be used to release the lock.
 */
export async function acquireLock(
  key: string,
  ttlSeconds: number,
  token: string,
): Promise<boolean> {
  const result = await redis.set(key, token, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

export async function releaseLock(key: string, token: string): Promise<boolean> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  const result = await redis.eval(script, 1, key, token);
  return Number(result) === 1;
}

export async function extendLock(key: string, token: string, ttlSeconds: number): Promise<boolean> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("expire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  const result = await redis.eval(script, 1, key, token, String(ttlSeconds));
  return Number(result) === 1;
}

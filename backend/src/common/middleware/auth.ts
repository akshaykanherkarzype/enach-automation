import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../exceptions/app-error.js';
import type { Role } from '../constants/index.js';

export interface AuthUser {
  sub: string;
  email: string;
  roles: Role[];
  name: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new UnauthorizedError('Invalid or missing token');
  }
}

export function requireRoles(...required: Role[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    await authenticate(request, _reply);
    const roles = request.user.roles || [];
    const ok = required.every((r) => roles.includes(r));
    if (!ok) {
      throw new ForbiddenError(`Requires roles: ${required.join(', ')}`);
    }
  };
}

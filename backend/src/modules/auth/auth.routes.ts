import type { FastifyInstance } from 'fastify';
import { env } from '../../common/config/env.js';
import { ROLES, type Role } from '../../common/constants/index.js';
import { UnauthorizedError, ValidationError } from '../../common/exceptions/app-error.js';

interface DevUser {
  email: string;
  name: string;
  password: string;
  roles: Role[];
}

function buildDevUsers(): DevUser[] {
  return [
    {
      email: env.DEV_USER_VIEW,
      name: 'Viewer',
      password: 'password',
      roles: [ROLES.VIEW],
    },
    {
      email: env.DEV_USER_UPLOAD,
      name: 'Uploader',
      password: 'password',
      roles: [ROLES.VIEW, ROLES.UPLOAD],
    },
    {
      email: env.DEV_USER_ADMIN,
      name: 'Admin',
      password: 'password',
      roles: [ROLES.VIEW, ROLES.UPLOAD, ROLES.RETRY],
    },
  ];
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    if (!body?.email || !body?.password) {
      throw new ValidationError('email and password are required');
    }

    const user = buildDevUsers().find(
      (u) => u.email === body.email && u.password === body.password,
    );
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const token = await reply.jwtSign({
      sub: user.email,
      email: user.email,
      name: user.name,
      roles: user.roles,
    });

    return reply.send({
      accessToken: token,
      user: {
        email: user.email,
        name: user.name,
        roles: user.roles,
      },
    });
  });

  app.get('/auth/me', {
    preHandler: [async (request, reply) => app.authenticate(request, reply)],
  }, async (request) => {
    return { user: request.user };
  });
}

import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { eq } from 'drizzle-orm';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { parseAuthChangePayload } from '../../contracts/supportRoutePayloads.js';

const limitAdminTokenChange = createRateLimitGuard({
  bucket: 'auth-change',
  max: 3,
  windowMs: 60_000,
});

export async function authRoutes(app: FastifyInstance) {
  // Change admin auth token (requires old token verification)
  app.post<{ Body: unknown }>(
    '/api/settings/auth/change',
    { preHandler: [limitAdminTokenChange] },
    async (request, reply) => {
    const parsedBody = parseAuthChangePayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const { oldToken, newToken } = parsedBody.data;

    if (!oldToken || !newToken) {
      return reply.code(400).send({ success: false, message: '请填写所有字段' });
    }

    if (newToken.length < 6) {
      return reply.code(400).send({ success: false, message: '新 Token 至少 6 个字符' });
    }

    if (oldToken !== config.authToken) {
      return reply.code(403).send({ success: false, message: '旧 Token 验证失败' });
    }

    // Save to settings table
    const existing = await db.select().from(schema.settings).where(eq(schema.settings.key, 'auth_token')).get();
    if (existing) {
      await db.update(schema.settings).set({ value: JSON.stringify(newToken) }).where(eq(schema.settings.key, 'auth_token')).run();
    } else {
      await db.insert(schema.settings).values({ key: 'auth_token', value: JSON.stringify(newToken) }).run();
    }

    // Update runtime config
    config.authToken = newToken;

    return { success: true, message: 'Token 已更新' };
    },
  );

  // Get masked current token (for display)
  app.get('/api/settings/auth/info', async () => {
    const token = config.authToken;
    const masked = token.length > 8
      ? token.slice(0, 4) + '****' + token.slice(-4)
      : '****';
    return { masked };
  });
}

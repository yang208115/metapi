import type { FastifyInstance } from 'fastify';
import { openTerminalLogStream } from '../../services/terminalLogService.js';

export async function terminalLogsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/system/terminal-logs/stream',
    async (request, reply) => {
      const requestedLimit = Number(request.query.limit);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(1_000, Math.trunc(requestedLimit)))
        : 300;

      reply.hijack();
      openTerminalLogStream(reply.raw, limit);
    },
  );
}

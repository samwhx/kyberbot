/**
 * KyberBot — Fleet Authentication Middleware
 *
 * Provides Express middleware that supports multi-agent token validation.
 * For /agent/:name/* routes, checks against that agent's token.
 * For root-level routes, checks against all agents (backward compat).
 */

import { Request, Response, NextFunction } from 'express';
import { loadTokenForRoot } from '../middleware/auth.js';
import { createLogger } from '../logger.js';

const logger = createLogger('fleet-auth');

/**
 * Extract bearer token from Authorization header.
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Create fleet-aware auth middleware.
 * Agents map: name → { root, apiToken }.
 */
export function createFleetAuthMiddleware(
  agents: Map<string, { root: string; apiToken: string }>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (agents.size === 0) {
      // Misconfiguration: fleet middleware mounted with no agents. Refuse all.
      res.status(503).json({ error: 'Service Unavailable', message: 'No agents configured' });
      return;
    }

    // Refuse to fall through to no-auth mode under any circumstance. If any
    // agent has no API token in its .env, the route 503s — operator must fix.
    const missingToken = [...agents.entries()].filter(([, a]) => !a.apiToken);
    if (missingToken.length > 0) {
      logger.error(
        `Fleet auth: agents missing API tokens: ${missingToken.map(([n]) => n).join(', ')}. ` +
        "Set KYBERBOT_API_TOKEN in each agent's .env (openssl rand -hex 32)."
      );
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'Agent authentication is not configured',
      });
      return;
    }

    const token = extractBearerToken(req);
    if (token) {
      for (const [name, agent] of agents) {
        if (token === agent.apiToken) {
          (req as any).agentName = name;
          (req as any).agentRoot = agent.root;
          return next();
        }
      }
    }

    // Auth failed
    const isLocal = req.ip === '::1' || req.ip === '127.0.0.1' || req.ip === '::ffff:127.0.0.1';
    if (isLocal) {
      logger.debug('Fleet auth failed from localhost', { path: req.path });
    } else {
      logger.warn('Fleet auth failed', { path: req.path, ip: req.ip });
    }

    res.status(401).json({ error: 'Unauthorized', message: 'Invalid API token' });
  };
}

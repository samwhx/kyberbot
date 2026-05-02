/**
 * KyberBot — Agent Router
 *
 * Creates an Express router with all routes scoped to a specific agent root.
 * Used by both single-agent mode (server/index.ts) and fleet mode (FleetManager).
 */

import express, { Router } from 'express';
import type { Express } from 'express';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { createBrainRouter } from './brain-api.js';
import { createWebApiRouter } from './web-api.js';
import { createManagementRouter } from './management-api.js';
import { createBusApiRouter } from './bus-api.js';
import { createArpRouter } from './arp/router.js';
import { chatSseHandler } from './chat-sse.js';
import { Channel } from './channels/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-router');

/**
 * Mount web UI static files on an Express app or router.
 * Call BEFORE auth middleware so browsers can load the page without a token.
 * @param app Express app or router to mount on
 * @param prefix URL prefix ('' for root, '/agent/name' for fleet)
 */
export function mountWebUi(app: { use: (...args: any[]) => any; get: (...args: any[]) => any }, prefix: string): void {
  try {
    const webDistPaths = [
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist'),
      join(process.cwd(), 'node_modules', '@kyberbot', 'web', 'dist'),
    ];

    for (const distPath of webDistPaths) {
      if (existsSync(join(distPath, 'index.html'))) {
        app.use(`${prefix}/ui`, express.static(distPath));
        app.get(`${prefix}/ui/*`, (_req: any, res: any) => {
          res.sendFile(join(distPath, 'index.html'));
        });
        logger.debug(`Web UI available at ${prefix || '/'}/ui`);
        return;
      }
    }

    // No dist found at any path. Without a loud warning, the operator hits
    // /ui in the browser and gets the auth-protected catch-all's 401 JSON
    // with no clue why the React app isn't rendering. This was a real
    // first-deploy footgun. Tell them what to do.
    logger.warn(
      `Web UI dist not found — /ui will fall through to the API and return 401 ` +
      `instead of the login screen. To fix: ` +
      `\`cd <kyberbot-source>/packages/web && npm install && npm run build\` ` +
      `(or \`npm run build\` from the kyberbot repo root after the build-script fix).`
    );
    logger.warn(`Searched: ${webDistPaths.join(' :: ')}`);
  } catch (err) {
    logger.warn('Web UI mount failed', { error: String(err) });
  }
}

/**
 * Create an Express router with all agent-specific routes.
 * Every route within this router operates in the context of the given root.
 * NOTE: Web UI is NOT included here — mount it separately before auth.
 */
export function createAgentRouter(root: string, channels: Channel[]): Router {
  const router = Router();

  // Brain API
  router.use('/brain', createBrainRouter(root));

  // Chat SSE — must be before the web router
  router.post('/api/web/chat', (req, res) => chatSseHandler(req, res, root));

  // Web API
  router.use('/api/web', createWebApiRouter(root));

  // Bus API (receives messages from remote agents/fleet)
  router.use('/api/bus', createBusApiRouter(root));

  // Management API
  router.use('/api/web/manage', createManagementRouter(channels, root));

  // ── ARP unification (Phase B) — typed agent-to-agent endpoints ─────
  // Mounted at /api/arp; the cloud-bridge kyberbot adapter dispatches
  // structured action requests here (notes.search, knowledge.query,
  // etc.) instead of running them through /api/web/chat. Each endpoint
  // filters by project_id / classification / tags at the data layer
  // and applies obligations as code. Cedar PDP on the cloud side
  // gates whether the call happens; this router enforces scope at the
  // brain.
  router.use('/api/arp', createArpRouter(root));

  return router;
}

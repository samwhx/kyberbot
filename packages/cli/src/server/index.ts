/**
 * KyberBot — Express Server
 *
 * Minimal server providing:
 * - Health endpoint
 * - Brain REST API
 * - Channel bridges (Telegram, WhatsApp)
 */

import express from 'express';
import { createLogger } from '../logger.js';
import { getServerPort, getIdentity, getRoot } from '../config.js';
import { authMiddleware, getApiToken } from '../middleware/auth.js';
import { createAgentRouter, mountWebUi } from './agent-router.js';
import { ServiceHandle } from '../types.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { Channel } from './channels/types.js';
import { getMetrics, errorMiddleware } from '../monitoring.js';
import { getServiceStatuses } from '../orchestrator.js';
import http from 'http';

const logger = createLogger('server');

const channels: Channel[] = [];

export { channels };

export async function startServer(options: {
  enableChannels?: boolean;
} = {}): Promise<ServiceHandle> {
  const root = getRoot();
  const app = express();
  const port = getServerPort();

  app.use(express.json());

  // Public health endpoint — comprehensive system status
  app.get('/health', (_req, res) => {
    const metrics = getMetrics();
    const services = getServiceStatuses();
    const allHealthy = services.every(s => s.status === 'running' || s.status === 'disabled');

    res.json({
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: metrics.uptime_human,
      channels: channels.map(c => ({ name: c.name, connected: c.isConnected() })),
      services: services.map(s => ({ name: s.name, status: s.status })),
      errors: metrics.errors,
      memory: metrics.memory,
      pid: metrics.pid,
      node_version: metrics.node_version,
    });
  });

  // Serve web UI static files BEFORE auth (browsers don't send Bearer tokens on page loads)
  mountWebUi(app, '');

  // Mount all agent routes via shared agent-router (authenticated)
  app.use('/', authMiddleware, createAgentRouter(root, channels));

  // Start channels if configured
  if (options.enableChannels !== false) {
    try {
      const identity = getIdentity();

      if (identity.channels?.telegram?.bot_token) {
        const telegram = new TelegramChannel(identity.channels.telegram, root);
        await telegram.start();
        channels.push(telegram);
      }

      if (identity.channels?.whatsapp?.enabled) {
        const ownerJid = identity.channels.whatsapp.owner_jid || null;
        const whatsapp = new WhatsAppChannel(root, ownerJid);
        await whatsapp.start();
        channels.push(whatsapp);
      }
    } catch (error) {
      logger.warn('Channel initialization failed (non-fatal)', { error: String(error) });
    }
  }

  // Error middleware — must be after all routes
  app.use(errorMiddleware);

  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    // Fail fast if no API token is configured. authMiddleware no longer
    // falls through to "open" mode, so a missing token would 401 every
    // request — surface the cause at startup instead.
    try {
      getApiToken();
    } catch (err) {
      reject(err);
      return;
    }

    // Default to localhost-only. Tailscale users should leave this as 127.0.0.1
    // and front the agent with `tailscale serve`, which proxies tailnet traffic
    // to the local port. Set KYBERBOT_BIND_HOST=0.0.0.0 only if you understand
    // the LAN/internet exposure and have other controls in place.
    const host = process.env.KYBERBOT_BIND_HOST || '127.0.0.1';

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${port} is already in use on ${host}. Another agent or process is running.`);
        reject(new Error(`Port ${port} is already in use on ${host}. Stop the other agent first, or change server.port in identity.yaml.`));
      } else {
        reject(error);
      }
    });

    server.listen(port, host, () => {
      logger.info(`Server listening on ${host}:${port}`);
      logger.info('API authentication enabled');
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        logger.warn(
          `Server is bound to ${host} — reachable beyond localhost. ` +
          `Ensure firewall/Tailscale ACLs are configured.`
        );
      }
      logger.info(`Web UI: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/ui`);

      resolve({
        stop: async () => {
          // Stop channels
          for (const channel of channels) {
            try {
              await channel.stop();
            } catch (error) {
              logger.error(`Failed to stop ${channel.name} channel`, { error: String(error) });
            }
          }
          channels.length = 0;

          // Stop server
          await new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
          logger.info('Server stopped');
        },
        status: () => (server.listening ? 'running' : 'stopped'),
      });
    });
  });
}

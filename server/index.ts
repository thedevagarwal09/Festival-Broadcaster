import http from 'node:http';
import express from 'express';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { configureDatabase, prisma } from './db';
import { Dispatcher } from './queue/dispatcher';
import { setIO, type IOServer } from './realtime';
import { createApiRouter } from './routes/api';
import { registerSocketHandlers } from './socket-handlers';
import { cleanIncoming, UPLOAD_DIR } from './upload';
import { Scheduler } from './services/scheduler';
import { isSameOrigin } from './utils/origin';
import { SessionManager } from './whatsapp/session-manager';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
// Loopback only by default: the app has no login, so anyone who can reach it can use your WhatsApp.
// The Docker image sets HOST=0.0.0.0 — keep that port on a trusted LAN/VPN only.
const host = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  await configureDatabase();

  const nextApp = next({ dev, hostname: 'localhost', port });
  const handleNext = nextApp.getRequestHandler();
  await nextApp.prepare();

  const app = express();
  app.disable('x-powered-by');
  const httpServer = http.createServer(app);

  const io: IOServer = new SocketIOServer(httpServer, {
    // Leave non-Socket.IO upgrades (Next.js HMR) alone instead of destroying them.
    destroyUpgrade: false,
    maxHttpBufferSize: 1e6,
    // Refuse handshakes started by other websites.
    allowRequest: (req, callback) => callback(null, isSameOrigin(req)),
  });
  setIO(io);

  const sessions = new SessionManager();
  const dispatcher = new Dispatcher(sessions);
  sessions.onConnected((sessionId) => dispatcher.kick(sessionId));
  sessions.onMessageStatus((_sessionId, receipts) => {
    dispatcher.handleReceipts(receipts).catch((err: unknown) => console.error('[dispatcher] receipts failed:', err));
  });
  const scheduler = new Scheduler(dispatcher);
  sessions.onLoggedOut((sessionId) => {
    dispatcher
      .pauseAllForSession(sessionId, 'the WhatsApp account was unlinked')
      .catch((err: unknown) => console.error('[dispatcher] pause on logout failed:', err));
  });

  // Block cross-site requests to the API (a page on another website calling localhost).
  app.use('/api', (req, res, next) => {
    if (isSameOrigin(req)) {
      next();
      return;
    }
    res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  });
  // Liveness probe for the Docker health check.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', createApiRouter({ sessions, dispatcher, onQuietHoursChanged: () => void scheduler.tick() }));
  app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false, index: false }));
  app.all('*', (req, res) => {
    void handleNext(req, res);
  });

  const handleUpgrade = nextApp.getUpgradeHandler();
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/socket.io')) return; // handled by Socket.IO
    void handleUpgrade(req, socket, head);
  });

  registerSocketHandlers(io, sessions);

  await cleanIncoming();
  await dispatcher.recover();
  await sessions.restoreSessions();
  scheduler.start();

  httpServer.listen(port, host, () => {
    console.log(`\n🎉  Festival Broadcaster ready on http://localhost:${port}  (${dev ? 'dev' : 'production'})\n`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down…`);
    await scheduler.stop();
    dispatcher.stop();
    await sessions.shutdown();
    io.close();
    httpServer.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[server] fatal error during startup:', err);
  process.exit(1);
});

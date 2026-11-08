import http from 'node:http';
import express from 'express';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { configureDatabase, prisma } from './db';
import { Dispatcher } from './queue/dispatcher';
import { setIO, type IOServer } from './realtime';
import { AuthStore, isSameOrigin, tokenFromRequest } from './auth/auth-store';
import { createApiRouter } from './routes/api';
import { createAuthRouter, requireAuth } from './routes/auth';
import { registerSocketHandlers } from './socket-handlers';
import { UPLOAD_DIR } from './upload';
import { SessionManager } from './whatsapp/session-manager';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);
// Loopback only by default: this app has no login screen, so never expose it to your network.
const host = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  await configureDatabase();

  const nextApp = next({ dev, hostname: 'localhost', port });
  const handleNext = nextApp.getRequestHandler();
  await nextApp.prepare();

  const app = express();
  app.disable('x-powered-by');
  const httpServer = http.createServer(app);

  const auth = new AuthStore();

  const io: IOServer = new SocketIOServer(httpServer, {
    // Leave non-Socket.IO upgrades (Next.js HMR) alone instead of destroying them.
    destroyUpgrade: false,
    maxHttpBufferSize: 1e6,
    // Refuse handshakes started by other websites.
    allowRequest: (req, callback) => callback(null, isSameOrigin(req)),
  });
  setIO(io);

  // Only unlocked browsers may open the live socket.
  io.use((socket, next) => {
    const token = tokenFromRequest(socket.request);
    if (auth.validate(token)) {
      (socket.data as { authToken?: string }).authToken = token;
      next();
    } else {
      next(new Error('unauthorized'));
    }
  });
  const dropLockedSockets = (): void => {
    for (const socket of io.sockets.sockets.values()) {
      const token = (socket.data as { authToken?: string }).authToken;
      if (!auth.validate(token, false)) socket.disconnect(true);
    }
  };
  auth.onRevoke(() => dropLockedSockets());
  const sweepTimer = setInterval(() => {
    auth.sweep();
    dropLockedSockets();
  }, 30_000);
  sweepTimer.unref();

  const sessions = new SessionManager();
  const dispatcher = new Dispatcher(sessions);
  sessions.onConnected((sessionId) => dispatcher.kick(sessionId));
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
  app.use('/api/auth', createAuthRouter(auth));
  app.use('/api', requireAuth(auth), createApiRouter({ sessions, dispatcher }));
  app.use('/uploads', requireAuth(auth), express.static(UPLOAD_DIR, { fallthrough: false, index: false }));
  app.all('*', (req, res) => {
    void handleNext(req, res);
  });

  const handleUpgrade = nextApp.getUpgradeHandler();
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/socket.io')) return; // handled by Socket.IO
    void handleUpgrade(req, socket, head);
  });

  registerSocketHandlers(io, sessions);

  await dispatcher.recover();
  await sessions.restoreSessions();

  httpServer.listen(port, host, () => {
    console.log(`\n🪔  Festival Broadcaster ready on http://localhost:${port}  (${dev ? 'dev' : 'production'})\n`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down…`);
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

import type { IOServer } from './realtime';
import { errorMessage } from './utils/errors';
import type { SessionManager } from './whatsapp/session-manager';
import { isValidSessionId } from '../src/lib/types';

function readSessionId(payload: unknown): string | null {
  const value = (payload as { sessionId?: unknown } | null)?.sessionId;
  return isValidSessionId(value) ? value : null;
}

export function registerSocketHandlers(io: IOServer, sessions: SessionManager): void {
  io.on('connection', (socket) => {
    socket.on('init_session', (payload) => {
      const sessionId = readSessionId(payload);
      if (!sessionId) {
        socket.emit('session_error', { message: 'Invalid session id.' });
        return;
      }

      // One browser tab follows exactly one WhatsApp session.
      for (const room of socket.rooms) {
        if (room !== socket.id && room !== sessionId) void socket.leave(room);
      }
      void socket.join(sessionId);

      sessions
        .ensureSession(sessionId)
        .then((snapshot) => {
          socket.emit('session_status', snapshot);
          if (snapshot.status === 'qr' && snapshot.qr) {
            socket.emit('qr_code', { sessionId, qr: snapshot.qr, attempt: snapshot.qrAttempt });
          }
          if (snapshot.status === 'connected' && snapshot.user) {
            socket.emit('session_connected', { ...snapshot.user, sessionId });
          }
        })
        .catch((err: unknown) => socket.emit('session_error', { message: errorMessage(err) }));
    });

    socket.on('refresh_qr', (payload) => {
      const sessionId = readSessionId(payload);
      if (!sessionId || !socket.rooms.has(sessionId)) {
        socket.emit('session_error', { message: 'Join the session before refreshing it.' });
        return;
      }
      sessions
        .refresh(sessionId)
        .then((snapshot) => socket.emit('session_status', snapshot))
        .catch((err: unknown) => socket.emit('session_error', { message: errorMessage(err) }));
    });
  });
}

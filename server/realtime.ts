import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/lib/types';

export type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;

let io: IOServer | null = null;

export function setIO(server: IOServer): void {
  io = server;
}

/** Emit an event to every browser tab subscribed to this WhatsApp session. */
export function emitToSession<E extends keyof ServerToClientEvents>(
  sessionId: string,
  event: E,
  payload: Parameters<ServerToClientEvents[E]>[0],
): void {
  if (!io) return;
  const room = io.to(sessionId) as unknown as { emit: (ev: string, data: unknown) => boolean };
  room.emit(event, payload);
}

/** Number of browser sockets currently watching a session. */
export function sessionWatcherCount(sessionId: string): number {
  return io?.sockets.adapter.rooms.get(sessionId)?.size ?? 0;
}

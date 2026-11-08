'use client';

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

/** One shared Socket.IO connection per browser tab (same origin as the Next.js app). */
export function getSocket(): AppSocket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], withCredentials: true });
  }
  return socket;
}

/** Close the connection when the app locks; the next getSocket() reconnects with the new cookie. */
export function disconnectSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

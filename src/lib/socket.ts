'use client';

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;

/** One shared Socket.IO connection per browser tab (same origin as the Next.js app). */
export function getSocket(): AppSocket {
  if (!socket) {
    // Default transports: start with HTTP long-polling, then upgrade to WebSocket when the network
    // allows it. Works behind reverse proxies that don't pass WebSockets through.
    socket = io({ path: '/socket.io' });
  }
  return socket;
}


import type { IncomingMessage } from 'node:http';

/**
 * Reject cross-site requests, so a page on another website can't drive this app through your
 * browser. Browsers always send Origin on cross-origin fetches, form posts and WebSocket
 * handshakes; a request with no Origin is a same-origin GET or a non-browser tool.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

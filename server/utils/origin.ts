import type { IncomingMessage } from 'node:http';

function headerValues(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase());
}

/** Extra public addresses from ALLOWED_ORIGINS, e.g. "https://wishes.example.com,http://203.0.113.5:3005". */
const EXTRA_HOSTS = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .flatMap((o) => {
      try {
        return [new URL(o).host.toLowerCase()];
      } catch {
        console.warn(`[origin] ignoring invalid ALLOWED_ORIGINS entry: ${o}`);
        return [];
      }
    }),
);

/**
 * Reject cross-site requests, so a page on another website can't drive this app through your
 * browser. Browsers always send Origin on cross-origin fetches, form posts and WebSocket
 * handshakes; a request with no Origin is a same-origin GET or a non-browser tool.
 *
 * Behind a reverse proxy the Host header may be rewritten (e.g. to 127.0.0.1:3005), so the
 * proxy's X-Forwarded-Host and the ALLOWED_ORIGINS list are accepted too. Browsers can't set
 * X-Forwarded-Host on cross-site requests, so this doesn't weaken the check.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (EXTRA_HOSTS.has(originHost)) return true;
  return [...headerValues(req.headers.host), ...headerValues(req.headers['x-forwarded-host'])].includes(originHost);
}

import express, { type Request, type RequestHandler, type Response } from 'express';
import {
  authCookie,
  clearedAuthCookie,
  tokenFromRequest,
  type AuthStore,
} from '../auth/auth-store';
import { isPinSet, setPin, verifyPin } from '../auth/pin';
import { errorMessage } from '../utils/errors';
import { isPinFormat, pinProblem } from '../../src/lib/pin';

type AsyncHandler = (req: Request, res: Response) => Promise<void>;
const ah =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function field(body: unknown, key: string): unknown {
  return (body as Record<string, unknown> | null | undefined)?.[key];
}

function lockedMessage(ms: number): { error: string; retryAfter: number } {
  const seconds = Math.ceil(ms / 1000);
  const wait = seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
  return { error: `Too many wrong PINs. Try again in ${wait}.`, retryAfter: seconds };
}

/** Express middleware: 401 unless the request carries a live unlock cookie. */
export function requireAuth(auth: AuthStore): RequestHandler {
  return (req, res, next) => {
    if (auth.validate(tokenFromRequest(req))) {
      next();
      return;
    }
    res.status(401).json({ error: 'Locked. Enter your PIN to continue.' });
  };
}

export function createAuthRouter(auth: AuthStore): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));

  /** Whether a PIN exists yet, and whether this browser is unlocked. Never touches the idle timer. */
  router.get(
    '/status',
    ah(async (req, res) => {
      res.json({
        pinSet: await isPinSet(),
        authenticated: auth.validate(tokenFromRequest(req), false),
      });
    }),
  );

  /** First run only: choose the PIN. Unlocks this browser straight away. */
  router.post(
    '/setup',
    ah(async (req, res) => {
      if (await isPinSet()) {
        res.status(409).json({ error: 'A PIN is already set. Unlock with it, or reset it with "npm run pin:reset".' });
        return;
      }
      const pin = field(req.body, 'pin');
      const problem = typeof pin === 'string' ? pinProblem(pin) : 'Enter exactly 4 digits.';
      if (problem || typeof pin !== 'string') {
        res.status(400).json({ error: problem });
        return;
      }
      await setPin(pin);
      auth.recordSuccess();
      res.setHeader('Set-Cookie', authCookie(auth.issue()));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/login',
    ah(async (req, res) => {
      const waitMs = auth.lockoutRemainingMs();
      if (waitMs > 0) {
        res.status(429).json(lockedMessage(waitMs));
        return;
      }
      if (!(await isPinSet())) {
        res.status(409).json({ error: 'No PIN has been set yet.' });
        return;
      }
      const pin = field(req.body, 'pin');
      if (isPinFormat(pin) && (await verifyPin(pin))) {
        auth.recordSuccess();
        res.setHeader('Set-Cookie', authCookie(auth.issue()));
        res.json({ ok: true });
        return;
      }
      const failure = auth.recordFailure();
      if (failure.lockMs > 0) {
        res.status(429).json(lockedMessage(failure.lockMs));
        return;
      }
      res.status(401).json({
        error: `Wrong PIN. ${failure.attemptsLeft} attempt${failure.attemptsLeft === 1 ? '' : 's'} left before a lockout.`,
        attemptsLeft: failure.attemptsLeft,
      });
    }),
  );

  router.post('/logout', (req, res) => {
    auth.revoke(tokenFromRequest(req));
    res.setHeader('Set-Cookie', clearedAuthCookie());
    res.json({ ok: true });
  });

  /** Keeps the server-side idle timer alive while the person is actively using the page. */
  router.post('/ping', requireAuth(auth), (_req, res) => {
    res.status(204).end();
  });

  /** Change the PIN. Requires the current PIN; signs out every other browser. */
  router.post(
    '/change',
    requireAuth(auth),
    ah(async (req, res) => {
      const waitMs = auth.lockoutRemainingMs();
      if (waitMs > 0) {
        res.status(429).json(lockedMessage(waitMs));
        return;
      }
      const current = field(req.body, 'currentPin');
      const next = field(req.body, 'newPin');
      if (!isPinFormat(current) || !(await verifyPin(current))) {
        const failure = auth.recordFailure();
        if (failure.lockMs > 0) {
          res.status(429).json(lockedMessage(failure.lockMs));
          return;
        }
        res.status(401).json({ error: 'Your current PIN is wrong.' });
        return;
      }
      const problem = typeof next === 'string' ? pinProblem(next) : 'Enter exactly 4 digits.';
      if (problem || typeof next !== 'string') {
        res.status(400).json({ error: problem });
        return;
      }
      if (next === current) {
        res.status(400).json({ error: 'The new PIN must be different from the current one.' });
        return;
      }
      await setPin(next);
      auth.recordSuccess();
      auth.revokeAll(tokenFromRequest(req));
      res.json({ ok: true });
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  router.use(((err: unknown, _req, res, _next) => {
    console.error('[auth] unhandled error:', err);
    res.status(500).json({ error: errorMessage(err) });
  }) as express.ErrorRequestHandler);

  return router;
}

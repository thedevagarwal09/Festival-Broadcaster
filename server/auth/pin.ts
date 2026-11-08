import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { prisma } from '../db';

const PIN_KEY = 'pinHash';
const KEY_LENGTH = 32;
/** scrypt cost: ~50–100 ms per check, which makes offline guessing of a copied hash slow. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(pin: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: MAX_MEMORY };
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Stored format: scrypt$N$r$p$saltHex$hashHex */
async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pin, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), key.toString('hex')].join('$');
}

export async function isPinSet(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: PIN_KEY } });
  return row !== null;
}

export async function setPin(pin: string): Promise<void> {
  const value = await hashPin(pin);
  await prisma.appSetting.upsert({ where: { key: PIN_KEY }, create: { key: PIN_KEY, value }, update: { value } });
}

export async function clearPin(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: PIN_KEY } });
}

/** Constant-time comparison against the stored hash. False when no PIN is set or the hash is malformed. */
export async function verifyPin(pin: string): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: PIN_KEY } });
  if (!row) return false;
  const [scheme, n, r, p, saltHex, hashHex] = row.value.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(pin, Buffer.from(saltHex, 'hex'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

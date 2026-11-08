import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/** WAL mode lets the UI read while the dispatcher writes. The setting persists in the DB file. */
export async function configureDatabase(): Promise<void> {
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  } catch (err) {
    console.warn('[db] could not enable WAL mode:', err);
  }
  // The PIN lock was removed; don't leave its hash lying around in older databases.
  await prisma.appSetting.deleteMany({ where: { key: 'pinHash' } }).catch(() => undefined);
}

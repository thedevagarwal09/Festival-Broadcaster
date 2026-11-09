// Runs before `prisma db push` (see Dockerfile and `npm run db:push`).
//
// The smart-groups feature was removed. Databases that ran it still have its table and columns,
// and `prisma db push` refuses to drop columns or tables that contain data ("data loss"), which
// would stop the container from starting. This clears that leftover data first so the schema
// update can drop them.
//
// IMPORTANT: every step first checks that the exact table/column exists. SQLite treats an unknown
// double-quoted identifier as a plain string, so `WHERE "smartKey" IS NOT NULL` on a database
// without that column would match EVERY row. Never run these statements unguarded.
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;
const prisma = new PrismaClient();

async function hasTable(table) {
  const rows = await prisma.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table);
  return rows.length > 0;
}

async function hasColumn(table, column) {
  if (!(await hasTable(table))) return false;
  const rows = await prisma.$queryRawUnsafe(`SELECT name FROM pragma_table_info(?) WHERE name = ?`, table, column);
  return rows.length > 0;
}

async function run(label, sql) {
  const n = await prisma.$executeRawUnsafe(sql);
  if (n > 0) console.log(`[cleanup] removed leftover ${label}: ${n}`);
  return n;
}

let cleaned = 0;
try {
  if (await hasColumn('ContactGroup', 'smartKey')) {
    // Only the three smart groups — groups people made themselves have smartKey = NULL.
    if (await hasTable('_ContactToContactGroup')) {
      cleaned += await run(
        'smart group memberships',
        `DELETE FROM "_ContactToContactGroup" WHERE "B" IN (SELECT "id" FROM "ContactGroup" WHERE "smartKey" IS NOT NULL)`,
      );
    }
    cleaned += await run('smart groups', `DELETE FROM "ContactGroup" WHERE "smartKey" IS NOT NULL`);
  }
  if (await hasTable('ChatActivity')) cleaned += await run('chat activity', `DELETE FROM "ChatActivity"`);
  for (const column of ['lid', 'lidCheckedAt', 'chatCategory', 'lastChatAt']) {
    if (await hasColumn('Contact', column)) {
      cleaned += await run(`contact ${column}`, `UPDATE "Contact" SET "${column}" = NULL WHERE "${column}" IS NOT NULL`);
    }
  }
  for (const column of ['historyCheckedAt', 'historyImportedAt', 'categorizedAt']) {
    if (await hasColumn('UserSession', column)) {
      cleaned += await run(`session ${column}`, `UPDATE "UserSession" SET "${column}" = NULL WHERE "${column}" IS NOT NULL`);
    }
  }
  if (cleaned > 0) console.log('[cleanup] smart-groups leftovers removed');
} catch (err) {
  // A brand-new database has no tables yet; anything else is worth seeing but must not block start-up.
  if (!/no such table/i.test(String(err))) console.warn('[cleanup] skipped:', err instanceof Error ? err.message : err);
} finally {
  await prisma.$disconnect();
}

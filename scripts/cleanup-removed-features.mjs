// Runs before `prisma db push` (see Dockerfile).
//
// The smart-groups feature was removed. Databases that ran it still have its table and columns,
// and `prisma db push` refuses to drop columns or tables that contain data ("data loss"), which
// would stop the container from starting. This clears that leftover data first so the schema
// update can drop them. Every step is skipped quietly when the table/column doesn't exist.
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;
const prisma = new PrismaClient();

const steps = [
  // The three smart groups (and their memberships). Campaigns that used them keep their history.
  ['smart group memberships', `DELETE FROM "_ContactToContactGroup" WHERE "B" IN (SELECT "id" FROM "ContactGroup" WHERE "smartKey" IS NOT NULL)`],
  ['smart groups', `DELETE FROM "ContactGroup" WHERE "smartKey" IS NOT NULL`],
  ['chat activity', `DELETE FROM "ChatActivity"`],
  ...['lid', 'lidCheckedAt', 'chatCategory', 'lastChatAt'].map((c) => [`contact ${c}`, `UPDATE "Contact" SET "${c}" = NULL WHERE "${c}" IS NOT NULL`]),
  ...['historyCheckedAt', 'historyImportedAt', 'categorizedAt'].map((c) => [`session ${c}`, `UPDATE "UserSession" SET "${c}" = NULL WHERE "${c}" IS NOT NULL`]),
];

let cleaned = 0;
for (const [label, sql] of steps) {
  try {
    const n = await prisma.$executeRawUnsafe(sql);
    if (n > 0) {
      cleaned += n;
      console.log(`[cleanup] removed leftover ${label}: ${n}`);
    }
  } catch {
    // Table or column not present — nothing to clean.
  }
}
if (cleaned > 0) console.log('[cleanup] smart-groups leftovers removed');
await prisma.$disconnect();

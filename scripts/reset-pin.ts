// Forgot your PIN? Run:  npm run pin:reset
// Clears the stored PIN hash. Your WhatsApp link, contacts, groups and campaigns are untouched.
// Restart the server afterwards, then open http://localhost:3000 to choose a new PIN.
import { prisma } from '../server/db';
import { clearPin } from '../server/auth/pin';

async function main(): Promise<void> {
  await clearPin();
  console.log('PIN cleared.');
  console.log('Restart the server (Ctrl-C, then "npm run dev") and open http://localhost:3000 to set a new PIN.');
}

main()
  .catch((err: unknown) => {
    console.error('Could not reset the PIN:', err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());

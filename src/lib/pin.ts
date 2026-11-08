// PIN rules shared by the browser (instant feedback) and the server (enforcement).

export const PIN_LENGTH = 4;

const COMMON_PINS = new Set([
  '1212', '1122', '1313', '1010', '2020', '2525', '2580', '0852', '1004',
  '2000', '2001', '2002', '1999', '1984', '6969', '5683', '0007',
]);

/** Returns why a PIN is not acceptable as a new PIN, or null when it is fine. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return 'Enter exactly 4 digits.';
  if (/^(\d)\1{3}$/.test(pin)) return 'Avoid repeating one digit, like 1111.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    return 'Avoid straight sequences, like 1234.';
  }
  if (COMMON_PINS.has(pin)) return 'That PIN is one of the most common. Pick a less obvious one.';
  return null;
}

export function isPinFormat(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}$/.test(value);
}

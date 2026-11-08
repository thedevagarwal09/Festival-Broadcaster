// Template rendering shared by the composer preview (browser) and the dispatcher (server).
//
// 1. Variables:  {{name}}, {{first_name}}, {{phone}}
// 2. Spintax:    {Happy Diwali|Wishing you a joyful Diwali}  — nesting is supported:
//                {Hi|Hello} {there|{{first_name}}}, {have a {great|lovely} day|enjoy}!
//
// Variables are substituted first so that `{{name}}` is never mistaken for a spintax group.

export interface TemplateVariables {
  name?: string | null;
  phone?: string | null;
}

export const FALLBACK_NAME = 'Friend';

export const TEMPLATE_VARIABLES = [
  { tag: '{{name}}', label: 'Full name', description: 'Contact name, or "Friend" if unknown' },
  { tag: '{{first_name}}', label: 'First name', description: 'First word of the contact name' },
  { tag: '{{phone}}', label: 'Phone', description: 'Recipient number, e.g. +919876543210' },
] as const;

/** Strip characters that would otherwise be interpreted as spintax syntax. */
function sanitize(value: string): string {
  return value.replace(/[{}|]/g, '').replace(/\s+/g, ' ').trim();
}

export function applyVariables(template: string, vars: TemplateVariables): string {
  const fullName = sanitize(vars.name ?? '') || FALLBACK_NAME;
  const firstName = fullName.split(' ')[0] || FALLBACK_NAME;
  const phone = sanitize(vars.phone ?? '');

  return template.replace(/\{\{\s*(name|first_name|phone)\s*\}\}/gi, (_match, key: string) => {
    switch (key.toLowerCase()) {
      case 'first_name':
        return firstName;
      case 'phone':
        return phone;
      default:
        return fullName;
    }
  });
}

const INNERMOST_GROUP = /\{([^{}]*)\}/;

/** Resolve spintax groups from the innermost outwards, picking one option at random each time. */
export function resolveSpintax(text: string, random: () => number = Math.random): string {
  let output = text;
  for (let guard = 0; guard < 10_000 && INNERMOST_GROUP.test(output); guard += 1) {
    output = output.replace(INNERMOST_GROUP, (_match, body: string) => {
      const options = body.split('|');
      return options[Math.floor(random() * options.length)] ?? '';
    });
  }
  return output;
}

export function renderMessage(template: string, vars: TemplateVariables, random?: () => number): string {
  return resolveSpintax(applyVariables(template, vars), random).trim();
}

/**
 * Number of distinct texts a template can produce (before variable substitution).
 * Computed exactly, including nested groups.
 */
export function countVariations(template: string): number {
  const placeholder = applyVariables(template, { name: 'x', phone: 'x' });
  let counter = 0;
  const counts = new Map<string, number>();
  let working = placeholder;

  // Repeatedly collapse innermost groups into tokens whose count is the sum of option counts.
  for (let guard = 0; guard < 10_000 && INNERMOST_GROUP.test(working); guard += 1) {
    working = working.replace(INNERMOST_GROUP, (_match, body: string) => {
      const total = body
        .split('|')
        .map((option) => tokenProduct(option, counts))
        .reduce((sum, n) => sum + n, 0);
      counter += 1;
      const token = `\u0000${counter}\u0000`;
      counts.set(token, total);
      return token;
    });
  }
  return Math.min(tokenProduct(working, counts), Number.MAX_SAFE_INTEGER);
}

function tokenProduct(text: string, counts: Map<string, number>): number {
  const tokens = text.match(/\u0000\d+\u0000/g) ?? [];
  return tokens.reduce((product, token) => product * (counts.get(token) ?? 1), 1);
}

/** Returns an error message when braces are unbalanced, otherwise null. */
export function validateTemplate(template: string): string | null {
  let depth = 0;
  for (const char of template) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return 'A closing "}" has no matching "{".';
  }
  if (depth > 0) return 'An opening "{" is never closed.';
  return null;
}

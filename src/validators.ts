import type { Json, Validator } from './types.js';

/** Exact, case-sensitive value matching; never matches object keys or substrings. */
export function findValuePaths(value: Json, expected: string, path = '$'): string[] {
  if (typeof value === 'string') return value === expected ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findValuePaths(item, expected, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => {
      const suffix = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
      return findValuePaths(item, expected, path + suffix);
    });
  }
  return [];
}

export function walletValidator(wallet: string): Validator {
  if (!wallet.trim()) throw new Error('Wallet must not be empty');
  return {
    name: 'wallet-presence',
    validate(details) {
      const matches = findValuePaths(details, wallet);
      return {
        name: this.name,
        passed: matches.length > 0,
        matches,
        message: matches.length ? 'Wallet found in order details' : 'Wallet absent from order details',
      };
    },
  };
}

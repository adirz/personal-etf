const SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;

/** Split pasted tickers on commas, semicolons or whitespace; uppercase and de-duplicate, keeping order. */
export function parseSymbols(text: string) {
  const all = [...new Set(text.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
  return { valid: all.filter(s => SYMBOL.test(s)), invalid: all.filter(s => !SYMBOL.test(s)) };
}

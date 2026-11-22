import { describe, expect, it } from 'vitest';
import { parseSymbols } from '../src/core/symbols.js';

describe('parseSymbols', () => {
  it('accepts commas, spaces, semicolons and new lines', () => {
    expect(parseSymbols('spy, VT;meta\nTEVA.ta  qqq').valid).toEqual(['SPY', 'VT', 'META', 'TEVA.TA', 'QQQ']);
  });
  it('removes duplicates regardless of case', () => {
    expect(parseSymbols('SPY spy Spy').valid).toEqual(['SPY']);
  });
  it('keeps exchange, fund, crypto, FX and index formats', () => {
    expect(parseSymbols('TCH-F11.TA ETH-USD EURUSD=X ^GSPC BRK-B').invalid).toEqual([]);
  });
  it('reports text that cannot be a ticker', () => {
    expect(parseSymbols("SPY אנרג'יאן $$$")).toEqual({ valid: ['SPY'], invalid: ["אנרג'יאן", '$$$'] });
  });
  it('handles empty input', () => {
    expect(parseSymbols(' ,\n ;')).toEqual({ valid: [], invalid: [] });
  });
});

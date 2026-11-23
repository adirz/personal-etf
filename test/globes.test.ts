import { describe, expect, it } from 'vitest';
import { parseGraph, parseInstrumentPage, parseStockTable } from '../src/providers/globes.js';

describe('Globes parsing', () => {
  it('maps security numbers to instruments', () => {
    const html = `<tr class="data" data-symbol="373019"> <td class="qName" width="175"><a name="jt83" href="/portal/instrument.aspx?instrumentid=83" title="אבוג&#39;ן">x</a></td></tr>`;
    expect(parseStockTable(html).get('373019')).toEqual({ instrumentId: '83', name: "אבוג'ן" });
  });
  it('accepts an instrument page only for the exact security number', () => {
    const html = '<div class="enName secName">ENERGEAN</div><span id="symbol">1155290</span><input id="instypeid" value="6" />';
    expect(parseInstrumentPage(html, '1155290')).toEqual({ typeId: '6', englishName: 'ENERGEAN' });
    expect(parseInstrumentPage(html, '1155291')).toBeNull();
  });
  it('converts agorot, uses the close, and dates bars in Israeli time', () => {
    const data = [[1795125601000, 2838, 2844, 2766, 2775, 100], [1795039201000, 2800, 2800, 2800, 0, 0]];
    expect(parseGraph({ data }, '2026-01-01')).toEqual([['2026-11-20', 27.75]]);
  });
  it('filters by start date and handles no data', () => {
    expect(parseGraph({ data: [[1795125601000, 1, 1, 1, 100, 0]] }, '2027-01-01')).toEqual([]);
    expect(parseGraph({ data: null }, '2026-01-01')).toEqual([]);
  });
});

import { XMLParser } from 'fast-xml-parser';
import { unzipSync, strFromU8 } from 'fflate';

const MAX_UNZIPPED = 50 * 1024 * 1024;
const NOT_EXCEL = 'This is not a readable Excel (.xlsx) file.';

type Node = Record<string, unknown>;
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text((v as Node)['#text']);
  return String(v);
};
const richText = (si: Node) => (si.t !== undefined ? text(si.t) : list(si.r as Node | Node[]).map(r => text(r.t)).join(''));
const columnIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Read the first visible worksheet as rows of strings. Empty cells are ''. */
export function readFirstSheet(bytes: Uint8Array): string[][] {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: f => {
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new Error('too large');
        return f.name.startsWith('xl/') && (f.name.endsWith('.xml') || f.name.endsWith('.rels'));
      },
    });
  } catch { throw new Error(NOT_EXCEL); }
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: false, processEntities: true });
  const read = (name: string) => (files[name] ? (xml.parse(strFromU8(files[name])) as Node) : undefined);

  const workbook = read('xl/workbook.xml')?.workbook as Node | undefined;
  const rels = read('xl/_rels/workbook.xml.rels')?.Relationships as Node | undefined;
  if (!workbook || !rels) throw new Error(NOT_EXCEL);
  const sheets = list((workbook.sheets as Node | undefined)?.sheet as Node | Node[]);
  const sheet = sheets.find(s => (s['@state'] ?? 'visible') === 'visible');
  const rel = list(rels.Relationship as Node | Node[]).find(r => r['@Id'] === sheet?.['@r:id']);
  if (!rel) throw new Error(NOT_EXCEL);
  const target = String(rel['@Target']).replace(/^\//, '');
  const data = read(target.startsWith('xl/') ? target : `xl/${target}`)?.worksheet as Node | undefined;
  if (!data) throw new Error(NOT_EXCEL);

  const shared = list((read('xl/sharedStrings.xml')?.sst as Node | undefined)?.si as Node | Node[]).map(richText);
  const out: string[][] = [];
  for (const row of list((data.sheetData as Node | undefined)?.row as Node | Node[])) {
    const cells: string[] = [];
    for (const c of list(row.c as Node | Node[])) {
      const type = c['@t'];
      const value = type === 's' ? shared[Number(text(c.v))] ?? '' : type === 'inlineStr' ? richText((c.is ?? {}) as Node) : text(c.v);
      cells[columnIndex(String(c['@r'] ?? 'A'))] = value.trim();
    }
    out.push(Array.from(cells, v => v ?? ''));
  }
  return out;
}

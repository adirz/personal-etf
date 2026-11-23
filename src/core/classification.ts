import { GLOBAL_REGION_SPLIT } from './regions.js';
import type { ExposureSpec } from './types.js';

export interface SimpleClassification {
  assetClass: string;
  region?: string;        // US | Israel | developed_ex_us | emerging | global
  sector?: string;        // stocks only
  bondType?: string;      // bonds only
}

const HAS_REGION = new Set(['equity', 'bond']);

/** True when part of the holding has no asset class, or its stocks or bonds have no region. */
export function needsClassification(spec: ExposureSpec) {
  return Object.entries(spec.classes).some(([cls, c]) => {
    if (cls === 'unclassified') return c.weight > 0;
    if (!HAS_REGION.has(cls)) return false;
    const region = c.dims?.region ?? spec.dims?.region;
    return !region || Object.keys(region).length === 0;
  });
}

/** What the prompt can prefill from a partly known spec. */
export function simpleFromSpec(spec: ExposureSpec): Partial<SimpleClassification> {
  const main = Object.entries(spec.classes).filter(([k]) => k !== 'unclassified').sort((a, b) => b[1].weight - a[1].weight)[0];
  if (!main) return {};
  const top = (m?: Record<string, number>) => (m ? Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] : undefined);
  const dims = { ...(spec.dims ?? {}), ...(main[1].dims ?? {}) };
  return { assetClass: main[0], region: top(dims.region), sector: top(dims.sector), bondType: top(dims.bondType) };
}

export function specFromSimple(c: SimpleClassification): ExposureSpec {
  const dims: Record<string, Record<string, number>> = {};
  if (HAS_REGION.has(c.assetClass) && c.region) dims.region = c.region === 'global' ? { ...GLOBAL_REGION_SPLIT } : { [c.region]: 1 };
  if (c.assetClass === 'equity' && c.sector) dims.sector = { [c.sector]: 1 };
  if (c.assetClass === 'bond' && c.bondType) {
    dims.bondType = { [c.bondType]: 1 };
    if (c.bondType === 'government') dims.credit = { government: 1 };
  }
  return { classes: { [c.assetClass]: { weight: 1, ...(Object.keys(dims).length ? { dims } : {}) } }, source: 'manual:classified' };
}

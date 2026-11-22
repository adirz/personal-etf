import { coingeckoProvider, frankfurterFx, manualProvider } from './others.js';
import type { FxProvider, Provider } from './types.js';
import { yahooProvider } from './yahoo.js';

export class Registry {
  providers = new Map<string, Provider>();
  fx: FxProvider[] = [];
  register(p: Provider) { this.providers.set(p.id, p); return this; }
  registerFx(f: FxProvider) { this.fx.push(f); return this; }
  get(id: string) { const p = this.providers.get(id); if (!p) throw new Error(`unknown provider ${id}`); return p; }
  fxFor(a: string, b: string) { return this.fx.find(f => f.supports(a) && f.supports(b)); }
}

/** Add new data sources here. */
export const defaultRegistry = () => new Registry()
  .register(yahooProvider())
  .register(coingeckoProvider())
  .register(manualProvider())
  .registerFx(frankfurterFx());

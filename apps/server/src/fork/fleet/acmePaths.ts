/**
 * Fork (Owner): what an Acme path is about, for fleet overlap reports.
 * Kept out of generic T3 code; only paths whose meaning is certain from the
 * repository layout are named, everything else stays unknown.
 */
export interface PathMeaning {
  readonly sku?: string;
  readonly provider?: string;
}

const ACME_REPO = /(^|[/:])example-com\/acme(\.git)?$/i;

/** SKU manifests and schemas name their SKU; deepline and rapidapi are provider packages. */
export function acmePathMeaning(repoKey: string | null, path: string): PathMeaning | null {
  if (repoKey === null || !ACME_REPO.test(repoKey)) return null;
  const manifest = /^server\/internal\/registry\/assets\/manifests\/([^/]+)\.json$/.exec(path);
  if (manifest) return { sku: manifest[1]! };
  const schema =
    /^server\/internal\/registry\/assets\/schemas\/([^/]+)\.(input|output)\.json$/.exec(path);
  if (schema) return { sku: schema[1]! };
  const provider = /^server\/internal\/(deepline|rapidapi)\//.exec(path);
  if (provider) return { provider: provider[1]! };
  return null;
}

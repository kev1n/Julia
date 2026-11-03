/**
 * Fork: what a changed path is about, for fleet overlap reports, from the `pathMeanings` rules in
 * `fork-fleet.json`. Each rule is `{ "repo": <regex on the repo key, case-insensitive>, "path":
 * <regex whose first capture group is the label>, "kind": "sku" | "provider" }`. The first rule
 * that matches names the path; paths no rule matches stay unknown.
 */
export type PathMeaningKind = "sku" | "provider";

export interface PathMeaningRule {
  readonly repo: RegExp;
  readonly path: RegExp;
  readonly kind: PathMeaningKind;
}

export type PathMeaning = { readonly [kind in PathMeaningKind]?: string };

/** The rules from the config file; a rule that is malformed or does not compile is skipped. */
export function parsePathMeanings(raw: unknown): ReadonlyArray<PathMeaningRule> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((rule: { repo?: unknown; path?: unknown; kind?: unknown }) => {
    if (typeof rule?.repo !== "string" || typeof rule.path !== "string") return [];
    if (rule.kind !== "sku" && rule.kind !== "provider") return [];
    try {
      return [{ repo: new RegExp(rule.repo, "i"), path: new RegExp(rule.path), kind: rule.kind }];
    } catch {
      return [];
    }
  });
}

export function pathMeaning(
  rules: ReadonlyArray<PathMeaningRule>,
  repoKey: string | null,
  path: string,
): PathMeaning | null {
  if (repoKey === null) return null;
  for (const rule of rules) {
    if (!rule.repo.test(repoKey)) continue;
    const label = rule.path.exec(path)?.[1];
    if (label !== undefined) return { [rule.kind]: label };
  }
  return null;
}

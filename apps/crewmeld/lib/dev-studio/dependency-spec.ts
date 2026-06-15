/**
 * Pip dependency-spec helpers for the package allow-list review flow.
 *
 * A "spec" is a single line as it appears in `manifest.dependencies.libraries`
 * / `requirements.txt` — e.g. `markdown>=3.5`, `requests`, `pkg[extra]>=1,<2`.
 * The review UI edits the base name and the version constraint as two separate
 * fields, so these helpers split / recombine specs and normalize names for
 * collision detection when folding in the sandbox's preset global packages.
 */

/** A spec decomposed into its base name (with extras) and version constraint. */
export interface DependencySpec {
  /** Package name, including any extras bracket (e.g. `pkg[extra]`). */
  name: string
  /** Everything after the name — operator + version (e.g. `>=3.5`), or `''`. */
  version: string
}

/** The first character of a PEP 508 version constraint / marker. */
const VERSION_BOUNDARY_RE = /[<>=!~;@\s]/

/**
 * Split a dependency spec into `{ name, version }`. Extras stay attached to the
 * name; the version captures the constraint operator and everything after it.
 * Surrounding whitespace is trimmed from both parts.
 */
export function parseSpec(raw: string): DependencySpec {
  const trimmed = raw.trim()
  const match = VERSION_BOUNDARY_RE.exec(trimmed)
  if (!match) return { name: trimmed, version: '' }
  const idx = match.index
  return {
    name: trimmed.slice(0, idx).trim(),
    version: trimmed.slice(idx).trim(),
  }
}

/** Recombine a `{ name, version }` pair back into a single spec string. */
export function formatSpec(spec: DependencySpec): string {
  return `${spec.name.trim()}${spec.version.trim()}`
}

/**
 * Normalize a package name for equality checks: strip extras + version,
 * lowercase, and collapse runs of `-`, `_`, `.` to a single hyphen (PEP 503).
 */
export function normalizeName(raw: string): string {
  const { name } = parseSpec(raw)
  const withoutExtras = name.replace(/\[.*$/, '')
  return withoutExtras.toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * Union two spec lists, deduplicating by normalized package name. Entries from
 * `preferred` win on a collision and are emitted first (in their original
 * order); entries from `others` are appended only when their name was not
 * already contributed by `preferred`.
 */
export function dedupeByName(preferred: string[], others: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const spec of [...preferred, ...others]) {
    const key = normalizeName(spec)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(spec)
  }
  return out
}

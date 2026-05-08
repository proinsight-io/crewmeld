/**
 * Param resolution metadata for runtime merging.
 *
 * Tools published to k8s pods and tools run via the local execute API both need
 * to fall back to env vars / preset values when the caller omits a param. This
 * module is the single source of truth for that logic so both code paths stay
 * in sync.
 *
 * Resolution order at request time: request body > env (via envMap) > preset.
 */

export interface ParamResolution {
  /** Defaults captured at publish time (e.g. non-secret testParams). String values, coerced at runtime. */
  preset: Record<string, string>
  /** Param-name → env-var name (e.g. host → CONN_HOST, password → CREWMELD_PASSWORD). */
  envMap: Record<string, string>
  /** Param-name → JSON-Schema type, used to coerce string env/preset values to number/boolean. */
  types: Record<string, string>
}

/** Tool parameter shape required to derive a ParamResolution (subset of ToolParameters). */
interface ParamProps {
  type?: string
  envName?: string
}

/**
 * Build a ParamResolution from tool parameters + presetParams.
 *
 * @param parameters - Tool parameter schema (with optional envName per property)
 * @param presetParams - Saved default values (typically non-secret testParams)
 */
export function extractParamResolution(
  parameters: { properties?: Record<string, ParamProps> } | undefined,
  presetParams: Record<string, string> | undefined
): ParamResolution {
  const props = parameters?.properties ?? {}
  const envMap: Record<string, string> = {}
  const types: Record<string, string> = {}
  for (const [k, p] of Object.entries(props)) {
    if (p?.envName) envMap[k] = p.envName
    if (p?.type) types[k] = p.type
  }
  return {
    preset: presetParams ?? {},
    envMap,
    types,
  }
}

/** True when no merging needs to happen (no preset, no envMap). */
export function isEmptyResolution(r: ParamResolution): boolean {
  return Object.keys(r.preset).length === 0 && Object.keys(r.envMap).length === 0
}

/**
 * Build the JS prelude that materializes `__merged__` (preset + env + body params)
 * inside an async wrapper. The caller is expected to define a `params` variable in
 * scope (the request body) before this prelude runs, then destructure from
 * `__merged__` afterwards.
 *
 * Indentation: caller chooses the per-line indent prefix (e.g. '  ' inside `run()`).
 */
export function buildJsResolvePrelude(r: ParamResolution, indent = '  '): string {
  const lines = [
    `const __PRESET__ = ${JSON.stringify(r.preset)};`,
    `const __ENV_MAP__ = ${JSON.stringify(r.envMap)};`,
    `const __PARAM_TYPES__ = ${JSON.stringify(r.types)};`,
    `const __coerce__ = (v, t) => {`,
    `  if (v === undefined || v === null || v === '') return v;`,
    `  if (t === 'number') { const n = Number(v); return Number.isFinite(n) ? n : v; }`,
    `  if (t === 'boolean') return v === true || v === 'true' || v === 1 || v === '1';`,
    `  return v;`,
    `};`,
    `const __presetCoerced__ = {};`,
    `for (const [__k__, __v__] of Object.entries(__PRESET__)) __presetCoerced__[__k__] = __coerce__(__v__, __PARAM_TYPES__[__k__]);`,
    `const __envFilled__ = {};`,
    `for (const [__k__, __envName__] of Object.entries(__ENV_MAP__)) {`,
    `  const __ev__ = (typeof process !== 'undefined' && process.env) ? process.env[__envName__] : undefined;`,
    `  if (__ev__ !== undefined && __ev__ !== '') __envFilled__[__k__] = __coerce__(__ev__, __PARAM_TYPES__[__k__]);`,
    `}`,
    // Drop body values that look like "untouched form defaults":
    //   1. empty/null/undefined — never override anything
    //   2. equal to a preset value that env can override — preset values are
    //      generation-time placeholders ("localhost", "3306"); when a real env
    //      value (CONN_HOST) exists, the placeholder shouldn't win just because
    //      it round-tripped through the form.
    // Stringified comparison handles type-coerced numbers (form sends 3306, preset stored "3306").
    `const __bodyClean__ = {};`,
    `for (const [__k__, __v__] of Object.entries(params || {})) {`,
    `  if (__v__ === undefined || __v__ === null || __v__ === '') continue;`,
    `  const __pc__ = __presetCoerced__[__k__];`,
    `  if (__envFilled__[__k__] !== undefined && __pc__ !== undefined && String(__pc__) === String(__v__)) continue;`,
    `  __bodyClean__[__k__] = __v__;`,
    `}`,
    `const __merged__ = Object.assign({}, __presetCoerced__, __envFilled__, __bodyClean__);`,
  ]
  return lines.map((l) => indent + l).join('\n')
}

/** Same as buildJsResolvePrelude but for Python (operates on `__params__` dict). */
export function buildPyResolvePrelude(r: ParamResolution): string {
  return [
    `__PRESET__ = ${JSON.stringify(r.preset)}`,
    `__ENV_MAP__ = ${JSON.stringify(r.envMap)}`,
    `__PARAM_TYPES__ = ${JSON.stringify(r.types)}`,
    '',
    'def __coerce__(v, t):',
    '    if v is None or v == "":',
    '        return v',
    '    if t == "number":',
    '        try:',
    '            sv = str(v)',
    '            return float(sv) if "." in sv else int(sv)',
    '        except Exception:',
    '            return v',
    '    if t == "boolean":',
    '        return v in (True, "true", "True", 1, "1")',
    '    return v',
    '',
    '__preset_coerced__ = { __k__: __coerce__(__v__, __PARAM_TYPES__.get(__k__)) for __k__, __v__ in __PRESET__.items() }',
    '__env_filled__ = {}',
    'import os as __os__',
    'for __k__, __env_name__ in __ENV_MAP__.items():',
    '    __ev__ = __os__.environ.get(__env_name__)',
    '    if __ev__ is not None and __ev__ != "":',
    '        __env_filled__[__k__] = __coerce__(__ev__, __PARAM_TYPES__.get(__k__))',
    // Drop body values that look like "untouched form defaults" — see JS prelude.
    '__body_clean__ = {}',
    'for __k__, __v__ in __params__.items():',
    '    if __v__ is None or __v__ == "":',
    '        continue',
    '    __pc__ = __preset_coerced__.get(__k__)',
    '    if __k__ in __env_filled__ and __pc__ is not None and str(__pc__) == str(__v__):',
    '        continue',
    '    __body_clean__[__k__] = __v__',
    '__merged__ = {**__preset_coerced__, **__env_filled__, **__body_clean__}',
  ].join('\n')
}

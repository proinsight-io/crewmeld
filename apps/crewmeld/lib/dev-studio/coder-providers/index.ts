import { claudecodeProvider } from './claudecode'
import { opencodeProvider } from './opencode'
import type { CoderProvider } from './types'

export type { CoderProvider, EntrypointOpts } from './types'

/** Resolve a coder provider by its persisted coderType. */
export function getCoderProvider(coderType: 'claudecode' | 'opencode'): CoderProvider {
  return coderType === 'opencode' ? opencodeProvider : claudecodeProvider
}

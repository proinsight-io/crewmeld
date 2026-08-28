import type { ScopeIdentity } from '@/lib/identity/types'
import type { buildWorkflowToolConfigs } from '../intent-router'
import type { getEmployeeKnowledgeBaseIds } from '../knowledge-query'
import type { resolveModelConfig } from '../model-config'

export interface PreparationIdentity {
  identity: ScopeIdentity | null
  connectionId: string | null
}

type ToolConfigs = Awaited<ReturnType<typeof buildWorkflowToolConfigs>>
type ModelConfig = Awaited<ReturnType<typeof resolveModelConfig>>
type KnowledgeBaseIds = Awaited<ReturnType<typeof getEmployeeKnowledgeBaseIds>>

export interface PreparationInput {
  loadIdentity: () => Promise<PreparationIdentity>
  loadModelConfig: () => Promise<ModelConfig>
  loadKnowledgeBaseIds: () => Promise<KnowledgeBaseIds>
  loadToolConfigs: (identity: PreparationIdentity) => Promise<ToolConfigs>
}

export interface PreparationResult {
  identity: PreparationIdentity
  modelConfig: ModelConfig
  knowledgeBaseIds: KnowledgeBaseIds
  toolConfigs: ToolConfigs
}

export async function prepareConversationRuntime(
  input: PreparationInput
): Promise<PreparationResult> {
  const identityPromise = input.loadIdentity()
  const modelConfigPromise = input.loadModelConfig()
  const knowledgeBaseIdsPromise = input.loadKnowledgeBaseIds()
  const toolConfigsPromise = identityPromise.then(input.loadToolConfigs)

  const [identity, modelConfig, knowledgeBaseIds, toolConfigs] = await Promise.all([
    identityPromise,
    modelConfigPromise,
    knowledgeBaseIdsPromise,
    toolConfigsPromise,
  ])

  return { identity, modelConfig, knowledgeBaseIds, toolConfigs }
}

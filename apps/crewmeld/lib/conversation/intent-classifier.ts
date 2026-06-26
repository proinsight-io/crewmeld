/**
 * Intent classifier — determine user intent path via lightweight LLM call
 *
 * Three intents:
 * - knowledge_only:    Pure knowledge base query, no workflow/SOP execution needed
 * - knowledge_then_sop: Query knowledge base for context first, then execute SOP
 * - direct_sop:         Execute workflow/SOP directly, no knowledge base needed
 */

import { createLogger } from '@crewmeld/logger'
import { t } from '@/lib/core/server-i18n'
import { mergeExtraParams } from './model-config'
import type { ConversationModelConfig, EngineMessage } from './types'

const logger = createLogger('IntentClassifier')

export type IntentType = 'knowledge_only' | 'knowledge_then_sop' | 'direct_sop'

export interface IntentResult {
  intent: IntentType
  reason: string
  /** Keywords for knowledge base search in knowledge_only / knowledge_then_sop */
  searchQuery: string | null
}

/**
 * Build system prompt for intent classification
 */
function buildClassifierPrompt(
  hasKnowledgeBase: boolean,
  hasTools: boolean,
  sopNames: string[],
  workflowNames: string[]
): string {
  const toolList = [
    ...sopNames.map((n) => `SOP: ${n}`),
    ...workflowNames.map((n) => `Workflow: ${n}`),
  ]

  return `You are an intent classifier. Based on the user's question, determine which processing path to follow.

## Available Resources
- Knowledge Base: ${hasKnowledgeBase ? 'Yes' : 'No'}
- Executable Tools: ${hasTools ? toolList.join(', ') : 'None'}

## Classification Rules

1. **knowledge_only** — The user is asking a question or querying information that can be answered solely by retrieving from the knowledge base, no action execution needed
   Examples: "What is the company's leave policy?", "What is the price for Product A?", "Where is the project report template?"

2. **knowledge_then_sop** — The user's request requires both knowledge base information as reference and SOP/workflow execution to complete the action
   Examples: "Apply for 3 days of leave based on company policy" (need to look up policy first, then execute leave SOP)
   Examples: "Send a quotation email to the client using the template" (need to look up template first, then execute email workflow)

3. **direct_sop** — The user explicitly requests an action to be performed, no additional knowledge base query needed
   Examples: "Check today's sales data", "Send a message to John", "Run data backup"

## Special Cases
- If there is no knowledge base, do not return knowledge_only or knowledge_then_sop
- If there are no executable tools, do not return direct_sop or knowledge_then_sop
- If the user is just chatting/greeting, return direct_sop (let the main conversation flow handle it)
- If neither is available (no knowledge base, no tools), return direct_sop

## Output Format
Return strict JSON only, no other content:
{"intent": "knowledge_only|knowledge_then_sop|direct_sop", "reason": "One sentence explaining the reason", "searchQuery": "Keywords for knowledge base retrieval (only for knowledge_only and knowledge_then_sop, otherwise null)"}`
}

/**
 * Call LLM for intent classification
 */
export async function classifyIntent(
  userMessage: string,
  recentHistory: EngineMessage[],
  modelConfig: ConversationModelConfig,
  options: {
    hasKnowledgeBase: boolean
    hasTools: boolean
    sopNames: string[]
    workflowNames: string[]
  }
): Promise<IntentResult> {
  // Fast path: go directly to direct_sop when no knowledge base
  if (!options.hasKnowledgeBase) {
    logger.info('No knowledge base bound, going directly to direct_sop')
    return { intent: 'direct_sop', reason: t('convIntentNoKnowledge'), searchQuery: null }
  }

  // Fast path: go directly to knowledge_only when no tools
  if (!options.hasTools) {
    logger.info('No available tools, going directly to knowledge_only')
    return { intent: 'knowledge_only', reason: t('convIntentNoWorkflow'), searchQuery: userMessage }
  }

  const systemPrompt = buildClassifierPrompt(
    options.hasKnowledgeBase,
    options.hasTools,
    options.sopNames,
    options.workflowNames
  )

  // Take last 3 messages as context (sufficient for intent judgment, reduce token cost)
  const recentContext = recentHistory
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-3)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content ?? '').slice(0, 200)}`)
    .join('\n')

  const userPrompt = recentContext
    ? `Conversation context:\n${recentContext}\n\nCurrent user message: ${userMessage}`
    : `Current user message: ${userMessage}`

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ]

  try {
    const response = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${modelConfig.apiKey}`,
      },
      body: JSON.stringify(
        mergeExtraParams(
          {
            model: modelConfig.model,
            messages,
            temperature: 0,
            max_tokens: 200,
            stream: false,
          },
          modelConfig.extraParams
        )
      ),
    })

    if (!response.ok) {
      const errorText = await response.text()
      logger.error('Intent classification LLM call failed', {
        status: response.status,
        error: errorText.slice(0, 200),
      })
      return fallbackClassify(options)
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }

    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) {
      logger.warn('Intent classification returned empty content')
      return fallbackClassify(options)
    }

    // Parse JSON response
    const parsed = parseClassifierResponse(content)
    logger.info('Intent classification result', { intent: parsed.intent, reason: parsed.reason })
    return parsed
  } catch (error) {
    logger.error('Intent classification error', error)
    return fallbackClassify(options)
  }
}

/**
 * Parse classifier JSON response
 */
function parseClassifierResponse(content: string): IntentResult {
  try {
    // Try extracting JSON (LLM may add text before/after JSON)
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn('Cannot extract JSON from classifier response', {
        content: content.slice(0, 200),
      })
      return { intent: 'direct_sop', reason: t('convIntentParseFailed'), searchQuery: null }
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
    const intent = parsed.intent as string
    const reason = (parsed.reason as string) ?? ''
    const searchQuery = (parsed.searchQuery as string) ?? null

    if (intent === 'knowledge_only' || intent === 'knowledge_then_sop' || intent === 'direct_sop') {
      return { intent, reason, searchQuery }
    }

    logger.warn('Unknown intent type', { intent })
    return {
      intent: 'direct_sop',
      reason: `${t('convIntentUnknown')}: ${intent}`,
      searchQuery: null,
    }
  } catch {
    logger.warn('Failed to parse classifier response JSON', { content: content.slice(0, 200) })
    return { intent: 'direct_sop', reason: t('convIntentParseError'), searchQuery: null }
  }
}

/**
 * Fallback classification — fallback strategy when LLM call fails
 */
function fallbackClassify(options: { hasKnowledgeBase: boolean; hasTools: boolean }): IntentResult {
  if (options.hasTools) {
    return { intent: 'direct_sop', reason: t('convIntentDegradeTools'), searchQuery: null }
  }
  if (options.hasKnowledgeBase) {
    return { intent: 'knowledge_only', reason: t('convIntentDegradeKnowledge'), searchQuery: null }
  }
  return { intent: 'direct_sop', reason: t('convIntentDegradeNoResource'), searchQuery: null }
}

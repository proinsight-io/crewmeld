/**
 * Persona (SOUL) system — build digital employee system prompt
 */

import type { digitalEmployees } from '@crewmeld/db/schema'
import type { InferSelectModel } from 'drizzle-orm'

type Employee = Pick<
  InferSelectModel<typeof digitalEmployees>,
  'id' | 'name' | 'description' | 'persona'
>

interface WorkflowInfo {
  id: string
  name: string
  description: string | null
}

interface SopInfo {
  id: string
  name: string
  description: string | null
  triggerType: string
  involvedWorkflows: string[]
}

const DEFAULT_PERSONA = `You are an intelligent digital employee assistant. Communicate with the user in a professional and friendly manner.
If the user's request matches a workflow you are bound to, invoke the corresponding tool to complete the task.
If you are unsure about the user's intent, proactively ask for clarification.`

/**
 * Build system prompt — three-layer injection: persona -> workflow description -> behavior constraints
 */
export function buildSystemPrompt(
  employee: Employee,
  workflows: WorkflowInfo[],
  sops: SopInfo[] = [],
  knowledgeReference?: string | null,
  userLanguage?: string,
  deniedSops: SopInfo[] = []
): string {
  const sections: string[] = []

  // Layer 1: Persona settings
  if (employee.persona?.trim()) {
    sections.push(employee.persona.trim())
  } else {
    sections.push(DEFAULT_PERSONA)
  }

  // Layer 2: Identity declaration
  sections.push(
    `\n## Identity\n- Name: ${employee.name}${employee.description ? `\n- Role: ${employee.description}` : ''}`
  )

  // Layer 3: Workflow capability description
  if (workflows.length > 0) {
    const workflowList = workflows
      .map(
        (wf) =>
          `- **${wf.name}**${wf.description ? `: ${wf.description}` : ''} (tool name: wf_${wf.id})`
      )
      .join('\n')
    sections.push(
      `\n## Available Workflows\nYou can invoke the following workflows to fulfill user requests:\n${workflowList}`
    )
  }

  // Layer 4: SOP information
  if (sops.length > 0) {
    const triggerLabels: Record<string, string> = {
      scheduled: 'Scheduled',
      event: 'Event-driven',
      manual: 'Manual',
    }
    const sopList = sops
      .map((sop) => {
        const trigger = triggerLabels[sop.triggerType] ?? sop.triggerType
        const wfNames = sop.involvedWorkflows.join(', ')
        return `- **${sop.name}**${sop.description ? `: ${sop.description}` : ''} (trigger: ${trigger}, workflows: ${wfNames})`
      })
      .join('\n')
    sections.push(
      `\n## Available Tasks\nYou can invoke the following tasks to fulfill user requests:\n${sopList}\n\nWhen the user's request involves a business scenario covered by the above tasks, you **must invoke the corresponding task tool** instead of answering on your own.`
    )
  }

  // Layer 4b: Restricted tasks — caller lacks permission (onNoPermission='deny')
  if (deniedSops.length > 0) {
    const deniedList = deniedSops
      .map((sop) => `- **${sop.name}**${sop.description ? `: ${sop.description}` : ''}`)
      .join('\n')
    sections.push(
      `\n## Restricted Tasks (No Permission)\nThe current user does NOT have permission to run the following tasks:\n${deniedList}\n\nYou must NOT invoke or attempt these tasks. If the user requests one of them, politely tell the user (in their language) that they do not have permission to run that task, naming the task; do not fabricate any result.`
    )
  }

  // Layer 5: Knowledge base reference info (injected by intent classifier)
  if (knowledgeReference?.trim()) {
    sections.push(
      `\n## Knowledge Base Reference\nThe following content was retrieved from the knowledge base. Use this information to answer the user's question:\n\n${knowledgeReference.trim()}`
    )
  }

  // Layer 6: Behavior constraints
  sections.push(`\n## Behavioral Guidelines
- **Response Language**: You must always reply in **${userLanguage ?? "the user's language"}**. Even if tool results are in another language, you must translate the content into ${userLanguage ?? "the user's language"} before replying. This is the highest-priority rule
- **Tool-First Principle (most important)**: When the user sends a task-oriented request (e.g. querying data, generating content, performing actions), you **must invoke the corresponding tool**. You are never allowed to answer using your own knowledge or stale results from conversation history. Even if similar tool results exist in the conversation history, you **must re-invoke the tool** to get the latest data. The system will automatically determine whether to intercept duplicate requests; you must not decide to skip tool calls on your own. Violating this rule is equivalent to fabricating data
- Only reply with natural language when the user's question is clearly casual chat, a greeting, or completely unrelated to any tool
- Extract tool call parameters from the user's message; proactively ask when required information is missing
- After tool execution completes, format the results as **structured Markdown** for the user: use headings (##/###), tables, ordered/unordered lists, code blocks, bold/italic formatting to make content clear and readable
- Plain text replies should also use Markdown formatting; avoid large blocks of unformatted text
- Do not fabricate non-existent tools or capabilities; do not use stale data from conversation history in place of tool calls
- Recognize status-inquiry intents: when the user asks about "progress", "status", "which step", "is it done", "execution results", etc., these are status queries — invoke the check_sop_status tool to check status rather than re-triggering the task
- **Never use the term "SOP"**: When replying to users, never use the word "SOP"; always use "task" instead`)

  return sections.join('\n')
}

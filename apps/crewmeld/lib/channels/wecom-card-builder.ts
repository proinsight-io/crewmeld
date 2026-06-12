/**
 * WeCom approval card builder
 *
 * Builds button_interaction type template_card for SOP approval scenarios.
 */

import { t } from './card-i18n'

/**
 * Build SOP approval card (button_interaction type)
 */
export function buildApprovalCard(options: {
  pauseId: string
  sopName: string
  nodeName: string
  senderName?: string
  previousResult?: string
  aiSummary?: string
  deadline?: string
  approvalPageUrl?: string
  language?: string
}): Record<string, unknown> {
  const {
    pauseId,
    sopName,
    nodeName,
    senderName,
    previousResult,
    aiSummary,
    deadline,
    approvalPageUrl,
  } = options
  const lang = options.language ?? 'zh'

  const horizontalContentList: Array<{ keyname: string; value: string }> = []

  if (senderName) {
    horizontalContentList.push({ keyname: t('sender', lang), value: senderName })
  }
  horizontalContentList.push({ keyname: t('sopProcess', lang), value: sopName })
  horizontalContentList.push({ keyname: t('approvalNode', lang), value: nodeName })
  if (deadline) {
    horizontalContentList.push({ keyname: t('deadline', lang), value: deadline })
  }
  if (aiSummary) {
    horizontalContentList.push({
      keyname: t('aiSummary', lang),
      value: truncate(aiSummary, 100),
    })
  }
  if (previousResult) {
    horizontalContentList.push({
      keyname: t('pendingContent', lang),
      value: truncate(formatPreviousResult(previousResult), 500),
    })
  }

  return {
    card_type: 'button_interaction',
    source: {
      icon_url: '',
      desc: 'CrewMeld',
    },
    main_title: {
      title: `📋 ${sopName} — ${t('needsApproval', lang)}`,
      desc: deadline ? `${t('deadline', lang)}: ${deadline}` : '',
    },
    sub_title_text: nodeName,
    // WeCom caps horizontal_content_list at 6 items; trim defensively.
    horizontal_content_list: horizontalContentList.slice(0, 6),
    card_action: {
      type: 1,
      url: approvalPageUrl || '',
    },
    button_list: [
      { text: t('approve', lang), style: 1, key: `approval_${pauseId}_approved` },
      { text: t('reject', lang), style: 2, key: `approval_${pauseId}_rejected` },
    ],
    task_id: pauseId,
  }
}

/**
 * Build approval-done card (state after buttons are replaced)
 */
export function buildApprovalDoneCard(params: {
  sopName: string
  nodeName: string
  decision: 'approved' | 'rejected'
  decidedBy: string
  senderName?: string
  previousResult?: string
  decidedAt?: Date
  language?: string
}): Record<string, unknown> {
  const lang = params.language ?? 'zh'
  const decisionText = params.decision === 'approved' ? t('approved', lang) : t('rejected', lang)
  const timeStr = (params.decidedAt ?? new Date()).toLocaleString(
    lang === 'zh' ? 'zh-CN' : 'en-US',
    { timeZone: 'Asia/Shanghai' }
  )

  const horizontalContentList: Array<{ keyname: string; value: string }> = []

  if (params.senderName) {
    horizontalContentList.push({ keyname: t('sender', lang), value: params.senderName })
  }
  horizontalContentList.push({ keyname: t('sopProcess', lang), value: params.sopName })
  horizontalContentList.push({ keyname: t('approvalNode', lang), value: params.nodeName })
  // The done card omits the (bulky) previous result — the approver already saw
  // it on the pending card — to stay within WeCom's 6-item horizontal_content_list cap.
  horizontalContentList.push({ keyname: t('result', lang), value: decisionText })
  horizontalContentList.push({ keyname: t('handler', lang), value: params.decidedBy })
  horizontalContentList.push({ keyname: t('handledAt', lang), value: timeStr })

  return {
    card_type: 'button_interaction',
    source: {
      icon_url: '',
      desc: 'CrewMeld',
    },
    main_title: {
      title: `📋 ${params.sopName} — ${t('approvalDone', lang).replace('📋 ', '')}`,
      desc: decisionText,
    },
    sub_title_text: params.nodeName,
    // WeCom caps horizontal_content_list at 6 items; trim defensively.
    horizontal_content_list: horizontalContentList.slice(0, 6),
    button_list: [
      { text: decisionText, style: params.decision === 'approved' ? 1 : 2, key: 'done' },
    ],
  }
}

function formatPreviousResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of ['result', 'output', 'content', 'text', 'summary', 'response']) {
        if (parsed[key] && typeof parsed[key] === 'string') {
          return parsed[key]
        }
      }
      const lines: string[] = []
      for (const [k, v] of Object.entries(parsed)) {
        if (k.startsWith('_')) continue
        if (v === null || v === undefined) continue
        lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      }
      return lines.join('\n') || raw
    }
  } catch {
    /* not JSON */
  }
  return raw
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 3)}...`
}

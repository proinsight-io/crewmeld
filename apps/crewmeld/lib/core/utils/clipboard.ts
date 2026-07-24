/**
 * Cross-environment clipboard copy
 *
 * navigator.clipboard.writeText is unavailable in non-HTTPS environments,
 * this function automatically falls back to the textarea + execCommand approach.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back to alternative approach
    }
  }

  // Fallback: textarea + execCommand
  const ta = document.createElement('textarea')
  ta.value = text
  ta.readOnly = true
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  ta.style.pointerEvents = 'none'
  const activeDialog = document.activeElement?.closest('[role="dialog"]')
  const container = activeDialog instanceof HTMLElement ? activeDialog : document.body
  container.appendChild(ta)

  try {
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, ta.value.length)

    if (!document.execCommand('copy')) {
      throw new Error('Unable to copy to clipboard')
    }
  } finally {
    ta.remove()
  }
}

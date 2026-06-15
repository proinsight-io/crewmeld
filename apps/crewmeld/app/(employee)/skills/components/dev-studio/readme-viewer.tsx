'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface ReadmeViewerProps {
  /** Raw markdown source to render. Empty string renders an empty container. */
  markdown: string
}

/**
 * Read-only markdown renderer for the README tab.
 *
 * Wraps `react-markdown` with GFM (tables, task lists, strikethrough) and the
 * `prose` typography classes so headings / lists / code blocks pick up the
 * theme tokens. Keep this component dumb — no fetching, no state — so it can
 * be reused both as the viewer pane and as the live preview inside
 * {@link ReadmeEditor}.
 */
export function ReadmeViewer({ markdown }: ReadmeViewerProps) {
  return (
    <div
      className='prose prose-sm max-w-none overflow-auto p-4 dark:prose-invert'
      data-testid='dev-studio:readme-viewer'
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  )
}

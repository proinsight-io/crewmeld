/** @vitest-environment jsdom */

import type { RenderResult } from '@testing-library/react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  navigator: dom.window.navigator,
})

vi.mock('@/hooks/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

let render: typeof import('@testing-library/react').render
let fireEvent: typeof import('@testing-library/react').fireEvent
let cleanup: typeof import('@testing-library/react').cleanup
let RagflowUploadDialog: typeof import('./ragflow-upload-dialog').RagflowUploadDialog

beforeAll(async () => {
  ;({ render, fireEvent, cleanup } = await import('@testing-library/react'))
  ;({ RagflowUploadDialog } = await import('./ragflow-upload-dialog'))
})

beforeEach(() => vi.restoreAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('RagflowUploadDialog', () => {
  it('leads QA uploads to CSV import preview without direct parse controls', () => {
    const view = render(
      <RagflowUploadDialog
        datasetId='qa-id'
        datasetType='qa'
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    )
    expect(view.getByTestId('knowledge:ragflow:upload:input')).toHaveAttribute(
      'accept',
      '.csv,text/csv'
    )
    expect(view.queryByTestId('knowledge:ragflow:upload:parse-on-upload')).not.toBeInTheDocument()
    expect(view.getByText('knowledge.qaUploadPreviewAction')).toBeInTheDocument()
  })

  it('retains document formats and direct parse control', () => {
    const view = render(
      <RagflowUploadDialog
        datasetId='doc-id'
        datasetType='document'
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    )
    expect(view.getByTestId('knowledge:ragflow:upload:input')).toHaveAttribute(
      'accept',
      expect.stringContaining('.pdf')
    )
    expect(view.getByTestId('knowledge:ragflow:upload:parse-on-upload')).toBeInTheDocument()
    expect(view.getByText('knowledge.uploadFormats')).toBeInTheDocument()
  })

  it('selects a QA CSV and fetches only the preview route', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              headers: ['question', 'answer'],
              rows: [{ row: 2, question: 'Q', answer: 'A' }],
              errors: [],
            },
          })
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const view: RenderResult = render(
      <RagflowUploadDialog
        datasetId='qa-id'
        datasetType='qa'
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    )
    fireEvent.change(view.getByTestId('knowledge:ragflow:upload:input'), {
      target: { files: [new File(['question,answer\nQ,A'], 'qa.csv', { type: 'text/csv' })] },
    })
    fireEvent.click(view.getByTestId('knowledge:ragflow:upload:submit'))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/employee/ragflow/datasets/qa-id/qa/preview')
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('/documents')
    await vi.waitFor(() =>
      expect(view.getByText('knowledge.qaPreviewImportDeferred')).toBeInTheDocument()
    )
  })

  it('rejects invalid QA files from selection and drop before fetch', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(
      <RagflowUploadDialog
        datasetId='qa-id'
        datasetType='qa'
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />
    )
    const pdf = new File(['pdf'], 'bad.pdf', { type: 'application/pdf' })
    fireEvent.change(view.getByTestId('knowledge:ragflow:upload:input'), {
      target: { files: [pdf] },
    })
    expect(view.getByText('knowledge.qaUploadInvalidType')).toBeInTheDocument()
    fireEvent.drop(view.getByTestId('knowledge:ragflow:upload:dropzone'), {
      dataTransfer: { files: [pdf] },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

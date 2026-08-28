import { describe, expect, it } from 'vitest'
import { getQaClientFileError, getQaPreviewUrl } from './ragflow-upload-dialog-logic'

describe('QA upload dialog logic', () => {
  it.each([
    [new File(['x'], 'bad.pdf', { type: 'application/pdf' }), 'INVALID_TYPE'],
    [new File(['x'], 'qa.csv', { type: 'application/pdf' }), 'INVALID_TYPE'],
    [
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'qa.csv', { type: 'text/csv' }),
      'FILE_TOO_LARGE',
    ],
  ])('rejects invalid selected or dropped files before preview', (file, error) => {
    expect(getQaClientFileError([file])).toBe(error)
  })

  it('accepts one practical CSV and targets only the preview endpoint', () => {
    expect(getQaClientFileError([new File(['x'], 'qa.csv', { type: 'text/csv' })])).toBeNull()
    expect(getQaPreviewUrl('qa/id')).toBe('/api/employee/ragflow/datasets/qa%2Fid/qa/preview')
  })
})

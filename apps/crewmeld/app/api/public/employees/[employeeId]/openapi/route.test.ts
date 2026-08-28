import { describe, expect, it } from 'vitest'
import { GET } from './route'

describe('employee conversation OpenAPI', () => {
  it('documents the complete published employee API surface', async () => {
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ employeeId: 'employee-1' }),
    })
    const document = await response.json()

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/public/employees/employee-1/status',
        '/api/public/employees/employee-1/conversations',
        '/api/public/employees/employee-1/conversations/{conversationId}/messages',
        '/api/public/employees/employee-1/conversations/{conversationId}/events',
        '/api/public/employees/employee-1/knowledge-bases',
        '/api/public/employees/employee-1/knowledge-bases/{datasetId}/questions/top',
      ])
    )
    expect(document.components.securitySchemes.ApiKeyAuth.name).toBe('X-API-Key')
  })
})

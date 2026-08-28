// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KnowledgeScopeBar } from './knowledge-scope-bar'

describe('KnowledgeScopeBar', () => {
  it('selects one category at a time and empty means all', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <KnowledgeScopeBar
        datasets={[
          { id: 'kb-1', knowledgeBaseId: 'local-kb-1', name: '锂电', type: 'qa' },
          { id: 'kb-2', knowledgeBaseId: 'local-kb-2', name: '发电机', type: 'document' },
        ]}
        selectedIds={[]}
        onChange={onChange}
      />
    )

    expect(screen.getByTestId('chat:knowledge:all')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByTestId('chat:knowledge:kb-1'))
    expect(onChange).toHaveBeenLastCalledWith(['kb-1'])

    rerender(
      <KnowledgeScopeBar
        datasets={[
          { id: 'kb-1', knowledgeBaseId: 'local-kb-1', name: '锂电', type: 'qa' },
          { id: 'kb-2', knowledgeBaseId: 'local-kb-2', name: '发电机', type: 'document' },
        ]}
        selectedIds={['kb-1']}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByTestId('chat:knowledge:kb-2'))
    expect(onChange).toHaveBeenLastCalledWith(['kb-2'])
    fireEvent.click(screen.getByTestId('chat:knowledge:all'))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})

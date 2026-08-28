/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HumanServicePage from './page'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('HumanServicePage', () => {
  it('keeps the page usable after replying from an insecure HTTP context', async () => {
    const handoff = {
      id: 'handoff-1',
      conversationId: 'conversation-1',
      customerUserId: 'customer-1',
      employeeName: '智能客服',
      channel: 'api',
      title: '充电异常',
      status: 'open',
      createdAt: '2026-08-04T12:00:00.000Z',
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [handoff] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', {})

    render(<HumanServicePage />)
    fireEvent.click(await screen.findByText('充电异常'))
    fireEvent.change(await screen.findByTestId('human-service:reply-input'), {
      target: { value: '电池寿命是10年' },
    })
    fireEvent.click(screen.getByTestId('human-service:reply'))

    expect(await screen.findByText('电池寿命是10年')).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  })
})

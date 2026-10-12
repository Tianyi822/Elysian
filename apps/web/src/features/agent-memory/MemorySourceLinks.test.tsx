import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { MemoryOriginLink } from './MemorySourceLinks'

describe('MemoryOriginLink', () => {
  it('keeps a manual request ID separate from its linked run', () => {
    render(
      <MemoryRouter>
        <MemoryOriginLink kind="manual" id="request-123" runId="run-456" />
      </MemoryRouter>,
    )

    expect(screen.getByText('request-123').tagName).toBe('SPAN')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('links a run origin to that run', () => {
    render(
      <MemoryRouter>
        <MemoryOriginLink kind="run" id="run-456" />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'run-456' }).getAttribute('href')).toBe('/agent/runs?runId=run-456')
  })
})

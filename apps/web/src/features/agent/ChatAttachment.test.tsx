import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ChatAttachment } from './ChatAttachment'

it.each([
  [1023, '1023 B'],
  [1025, '2 KiB'],
  [1024 ** 2 - 1, '1024 KiB'],
  [1024 ** 2, '1.0 MiB'],
])('附件 %d 字节显示为 %s', (size, label) => {
  render(<ChatAttachment attachment={{ id: 'local', serverId: 'uploaded', name: 'notes.txt', size, type: 'text/plain', lastModified: 0, available: true }} />)
  expect(screen.getByText(label)).toBeInTheDocument()
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { FileEntry } from '@elysian/contracts'
import { GatewayProvider } from '../../adapters/GatewayProvider'
import { createMockGateway } from '../../adapters/mock/gateway'
import { PermissionDialog } from './PermissionDialog'

/*
 * 权限对话框的属主候选口径：解析不出账号名的属主（uid 数字串）不进候选、不作默认值
 * ——真实实现里改属主要过主机账号判据，这样的候选选中即必然失败；默认回落 root，
 * 实际属主仍显示在文件列表里，不在对话框里复述。
 */

function fileEntry(owner: string): FileEntry {
  return {
    name: 'a.txt',
    kind: 'file',
    mode: '644',
    owner,
    sizeBytes: 10,
    modifiedAt: '2026-09-22T08:00:00.000Z',
  }
}

function renderDialog(owner: string) {
  return render(
    <GatewayProvider gateway={createMockGateway({ eventStream: 'memory' })}>
      <PermissionDialog entry={fileEntry(owner)} entryPath="/tmp/a.txt" onClose={() => {}} />
    </GatewayProvider>,
  )
}

describe('权限对话框的属主候选', () => {
  it('当前属主是账号名时照常默认选中，账号在候选里', async () => {
    renderDialog('deploy')
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('deploy')
    await userEvent.click(trigger)
    expect(await screen.findByRole('option', { name: 'deploy' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '12345' })).not.toBeInTheDocument()
  })

  it('当前属主是解析不出名字的 uid 串：默认回落 root，uid 串不进候选', async () => {
    renderDialog('12345')
    // 对话框默认值是 root，而不是必然提交失败的 '12345'
    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('root')
    expect(trigger.textContent).not.toContain('12345')
    await userEvent.click(trigger)
    expect(await screen.findByRole('option', { name: 'root' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '12345' })).not.toBeInTheDocument()
  })
})

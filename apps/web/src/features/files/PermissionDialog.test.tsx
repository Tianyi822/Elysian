import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
    const trigger = screen.getByRole('button', { name: /所有者/ })
    expect(trigger.textContent).toContain('deploy')
    await userEvent.click(trigger)
    expect(await screen.findByRole('menuitemradio', { name: 'deploy' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: '12345' })).not.toBeInTheDocument()
  })

  it('当前属主是解析不出名字的 uid 串：默认回落 root，uid 串不进候选', async () => {
    renderDialog('12345')
    // 对话框默认值是 root，而不是必然提交失败的 '12345'
    const trigger = screen.getByRole('button', { name: /所有者/ })
    expect(trigger.textContent).toContain('root')
    expect(trigger.textContent).not.toContain('12345')
    await userEvent.click(trigger)
    expect(await screen.findByRole('menuitemradio', { name: 'root' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: '12345' })).not.toBeInTheDocument()
  })
})

describe('权限位输入框与输入法', () => {
  it('确认回车派发于组合结束之后时不改权限，随后的人工提交才改权限', async () => {
    const user = userEvent.setup()
    const gateway = createMockGateway({ eventStream: 'memory' })
    const chmod = vi.spyOn(gateway.files, 'chmod')
    const onClose = vi.fn()
    render(
      <GatewayProvider gateway={gateway}>
        <PermissionDialog
          entry={{ ...fileEntry('deploy'), name: 'auth.log', mode: '640' }}
          entryPath="/var/log/auth.log"
          onClose={onClose}
        />
      </GatewayProvider>,
    )
    const field = screen.getByLabelText('权限位')
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: '750' } })
    fireEvent.compositionEnd(field)
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })).toBe(false)
    // jsdom 的 keyDown 不触发隐式提交：手动补一次，验证 onSubmit 同样吞掉这枚回车。
    fireEvent.submit(field.closest('form')!)
    expect(chmod).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(field).toHaveValue('750')

    await user.click(screen.getByRole('button', { name: '应用' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(chmod).toHaveBeenCalledTimes(1)
    expect(chmod).toHaveBeenCalledWith('/var/log/auth.log', { mode: '750', owner: 'deploy', recursive: false })
  })
})

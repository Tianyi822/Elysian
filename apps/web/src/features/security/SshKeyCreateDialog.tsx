import * as Dialog from '@radix-ui/react-dialog'
import { useId, useState } from 'react'
import { SSH_KEY_NAME_MAX_LENGTH, isValidSshKeyName } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { X } from '../../components/icons'
import { useSshStore } from '../../stores/sshStore'

/**
 * 创建 SSH 密钥弹窗：只收一个自定义名称，密钥对由演示引擎按名称确定性生成。
 * 名称校验在界面层先做一次（空、超长、与已有名称重复都就地报错），adapter 侧用同一判据再挡一次。
 */
export function SshKeyCreateDialog() {
  const gateway = useGateway()
  const keys = useSshStore((s) => s.keys)
  const creating = useSshStore((s) => s.creatingKey)
  const closeCreateKey = useSshStore((s) => s.closeCreateKey)
  const createKey = useSshStore((s) => s.createKey)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const nameInputId = useId()

  const submit = () => {
    const trimmed = name.trim()
    if (!isValidSshKeyName(trimmed)) {
      setNameError(`密钥名称需为 1-${SSH_KEY_NAME_MAX_LENGTH} 个字符`)
      return
    }
    if (keys.some((key) => key.name === trimmed)) {
      setNameError(`密钥名称已存在：${trimmed}`)
      return
    }
    setNameError(undefined)
    void createKey(gateway, { name: trimmed })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCreateKey() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的名称不该因为一次误点丢掉。Esc 与「取消」「关闭」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">创建 SSH 密钥</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                演示 · 待接入真实执行
              </span>
              <span className="text-sm font-medium text-fg">创建 SSH 密钥</span>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭弹窗"
                className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
              >
                <X aria-hidden size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="px-4 py-4">
            <label htmlFor={nameInputId} className="mb-1 block text-xs font-medium text-fg-muted">
              密钥名称 <span className="text-danger">*</span>
            </label>
            <input
              id={nameInputId}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameError(undefined)
              }}
              placeholder="如 部署机"
              className="w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
            {nameError ? <p className="mt-1 text-xs text-danger">{nameError}</p> : null}
            <p className="mt-2 text-xs text-fg-subtle">
              名称用于在列表里辨认这把密钥；密钥对由演示引擎按名称生成，不对应任何真实主机。
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <p className="text-xs text-fg-subtle">只改演示数据集。</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => closeCreateKey()}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={creating}
                className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
              >
                创建密钥
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

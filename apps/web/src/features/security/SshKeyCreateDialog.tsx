import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import { useEffect, useId, useState } from 'react'
import { SSH_KEY_NAME_MAX_LENGTH, isValidSshKeyName } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Check, ChevronDown, X } from '../../components/icons'
import { useSshStore } from '../../stores/sshStore'
import { useUsersStore } from '../../stores/usersStore'
import { ACTION_CLASS } from './sshCardParts'

/**
 * 创建 SSH 密钥弹窗：选归属账号、起一个名称，其余由演示引擎生成。
 *
 * 密钥不是孤立的——公钥要写进某个账号的 authorized_keys，所以归属账号是必填的第一项，
 * 弹窗底部用一块说明把「创建后会怎样」讲清楚，避免只填完两个字段还不知道发生了什么。
 * 账号列表从账号 store 现取（账号名的家在那里），打开时若还没加载就顺手加载一次。
 */
export function SshKeyCreateDialog() {
  const gateway = useGateway()
  const keys = useSshStore((s) => s.keys)
  const creating = useSshStore((s) => s.creatingKey)
  const closeCreateKey = useSshStore((s) => s.closeCreateKey)
  const createKey = useSshStore((s) => s.createKey)
  const users = useUsersStore((s) => s.users)
  const usersStatus = useUsersStore((s) => s.status)
  const loadUsers = useUsersStore((s) => s.load)
  const [name, setName] = useState('')
  const [userId, setUserId] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [ownerError, setOwnerError] = useState<string | undefined>(undefined)
  const nameInputId = useId()
  const ownerLabelId = useId()

  useEffect(() => {
    if (usersStatus === 'idle') void loadUsers(gateway)
  }, [gateway, loadUsers, usersStatus])

  const submit = () => {
    const trimmed = name.trim()
    const owner = users.find((user) => user.id === userId)
    if (!owner) {
      setOwnerError('请选择归属账号')
      return
    }
    if (!isValidSshKeyName(trimmed)) {
      setNameError(`密钥名称需为 1-${SSH_KEY_NAME_MAX_LENGTH} 个字符`)
      return
    }
    if (keys.some((key) => key.name === trimmed)) {
      setNameError(`密钥名称已存在：${trimmed}`)
      return
    }
    setOwnerError(undefined)
    setNameError(undefined)
    void createKey(gateway, { name: trimmed, userId: owner.id })
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
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
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

          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
            <div>
              <div className="mb-2 flex items-center gap-1 text-xs font-medium text-fg-muted">
                <label id={ownerLabelId}>归属账号</label>
                <span className="text-danger">*</span>
              </div>
              <Select.Root value={userId || undefined} onValueChange={setUserId}>
                <Select.Trigger
                  aria-labelledby={ownerLabelId}
                  className="flex h-[34px] w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors data-[placeholder]:text-fg-subtle hover:border-fg-subtle"
                >
                  <Select.Value placeholder="选择这个密钥归谁用" />
                  <Select.Icon>
                    <ChevronDown aria-hidden size={14} className="shrink-0 text-fg-subtle" />
                  </Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Content
                    position="popper"
                    sideOffset={4}
                    // 层级抬到对话框（z-61）与遮罩（z-60）之上：弹层与对话框同为 60 时谁在上面
                    // 取决于 DOM 顺序与堆叠上下文，对话框面板是不透明的，被盖住就等于点了没反应。
                    className="z-[70] max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-surface p-1 text-xs shadow-lg"
                  >
                    {users.length === 0 ? (
                      // 账号没加载出来时，弹层会是一个看不见的空盒——点开毫无反馈，等于坏掉。
                      // 这里按加载状态给出明确的一行说明，至少让这一次点击有结果。
                      <p className="px-2 py-1.5 text-xs text-fg-muted">
                        {usersStatus === 'loading' || usersStatus === 'idle'
                          ? '正在加载账号…'
                          : usersStatus === 'error'
                            ? '账号列表加载失败，关掉弹窗重开再试'
                            : '还没有可选的账号，先去「用户管理」创建一个'}
                      </p>
                    ) : (
                      <Select.Viewport>
                        {users.map((user) => (
                          <Select.Item
                            key={user.id}
                            value={user.id}
                            className="flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-fg-muted outline-none data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                          >
                            <Select.ItemText>{user.name}</Select.ItemText>
                            <Select.ItemIndicator className="ml-auto inline-flex w-3.5 text-fg">
                              <Check aria-hidden size={13} />
                            </Select.ItemIndicator>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    )}
                  </Select.Content>
                </Select.Portal>
              </Select.Root>
              {ownerError ? <p className="mt-1 text-xs text-danger">{ownerError}</p> : null}
              <p className="mt-2 text-xs text-fg-subtle">
                公钥会写进这个账号的 authorized_keys，因此拿到私钥的人是以它的身份登录。
              </p>
            </div>

            <div>
              <div className="mb-2 flex items-center gap-1 text-xs font-medium text-fg-muted">
                <label htmlFor={nameInputId}>密钥名称</label>
                <span className="text-danger">*</span>
              </div>
              <input
                id={nameInputId}
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setNameError(undefined)
                }}
                placeholder="如 部署机"
                className="h-[34px] w-full rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
              />
              {nameError ? <p className="mt-1 text-xs text-danger">{nameError}</p> : null}
              <p className="mt-2 text-xs text-fg-subtle">
                名称只用于在列表里辨认这把密钥，最长 {SSH_KEY_NAME_MAX_LENGTH} 个字符。
              </p>
            </div>

            {/* 只写字段不说明后果，填完也不知道下一步做什么，这块就是补这个。 */}
            <div className="rounded-lg bg-surface-raised px-3 py-3">
              <p className="mb-1.5 text-xs font-medium text-fg-muted">创建后</p>
              <ul className="flex flex-col gap-1 text-xs text-fg-muted">
                <li>公钥记到所选账号名下，密钥列表里按账号能查到这把密钥。</li>
                <li>私钥可在列表行内随时查看与下载，删除密钥即撤销这次授权。</li>
              </ul>
              <p className="mt-2 text-xs text-fg-subtle">
                密钥材料是演示数据，由演示引擎按名称生成，不对应任何真实主机。
              </p>
            </div>
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
              <button type="button" onClick={submit} disabled={creating} className={ACTION_CLASS}>
                创建密钥
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

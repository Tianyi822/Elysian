import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import { useId, useState } from 'react'
import { SSH_KEY_NAME_MAX_LENGTH, isValidSshKeyName } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { Check, ChevronDown, X } from '../../components/icons'
import { useSshStore } from '../../stores/sshStore'
import { ACTION_CLASS } from './sshCardParts'

/**
 * 创建 SSH 密钥弹窗：选归属账号、起一个名称，密钥对由 adapter 生成。
 *
 * 密钥不是孤立的——公钥要写进某个账号的 authorized_keys，所以归属账号是必填的第一项，
 * 弹窗底部用一块说明把「创建后会怎样」讲清楚，避免只填完两个字段还不知道发生了什么。
 * 账号清单来自 SSH store 的 keyAccounts（面板加载时一并取回）：mock 下是账号数据集的种子，
 * Docker 运行时是 getent 读到的真实系统账号，弹窗本身不感知数据来自哪里。
 * 创建成功后由一次性私钥弹窗展示私钥（见 SshKeyRevealDialog），这里不出现密钥材料。
 */
export function SshKeyCreateDialog() {
  const gateway = useGateway()
  const keys = useSshStore((s) => s.keys)
  const keyAccounts = useSshStore((s) => s.keyAccounts)
  const creating = useSshStore((s) => s.creatingKey)
  const closeCreateKey = useSshStore((s) => s.closeCreateKey)
  const createKey = useSshStore((s) => s.createKey)
  const [name, setName] = useState('')
  const [userId, setUserId] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [ownerError, setOwnerError] = useState<string | undefined>(undefined)
  const nameInputId = useId()
  const ownerLabelId = useId()

  const submit = () => {
    const trimmed = name.trim()
    const owner = keyAccounts.find((account) => account.id === userId)
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
              {/* 真实执行时不加任何标注——动作就是动作；演示态保留提示。 */}
              {!isDockerRuntime() ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              ) : null}
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
                    {keyAccounts.length === 0 ? (
                      // 账号清单为空时，弹层会是一个看不见的空盒——点开毫无反馈，等于坏掉。
                      // 这里给出明确的一行说明，至少让这一次点击有结果。
                      <p className="px-2 py-1.5 text-xs text-fg-muted">
                        还没有可选的账号，先创建一个可登录的主机账号
                      </p>
                    ) : (
                      <Select.Viewport>
                        {keyAccounts.map((account) => (
                          <Select.Item
                            key={account.id}
                            value={account.id}
                            className="flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-fg-muted outline-none data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                          >
                            <Select.ItemText>{account.name}</Select.ItemText>
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
                <li>私钥只在创建完成后展示这一次，请当场下载保存；关闭弹窗后无法再取回。</li>
                <li>删除密钥即撤销这次授权，公钥会从账号的授权文件里移除。</li>
              </ul>
              <p className="mt-2 text-xs text-fg-subtle">
                {isDockerRuntime()
                  ? '密钥对由容器内 ssh-keygen 真实生成，公钥写入所选账号的授权文件。'
                  : '密钥材料是演示数据，由演示引擎按名称生成，不对应任何真实主机。'}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            {/* ml-auto 保证按钮组恒靠右：演示态左侧有说明文字、真实态没有，布局都不变。 */}
            {!isDockerRuntime() ? <p className="text-xs text-fg-subtle">只改演示数据集。</p> : null}
            <div className="ml-auto flex gap-2">
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

import { useEffect, useMemo, useState } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import {
  FILE_PERMISSION_ACTIONS,
  FILE_PERMISSION_ACTION_LABELS,
  FILE_PERMISSION_CLASSES,
  FILE_PERMISSION_CLASS_LABELS,
  isValidFileMode,
  isValidHostUserName,
  modeToPermission,
  permissionToMode,
} from '@elysian/contracts'
import type { FileEntry, FilePermission, FilePermissionAction, FilePermissionClass } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Check, ChevronDown } from '../../components/icons'
import { useFilesStore } from '../../stores/filesStore'

/*
 * 权限对话框：三类人（所有者、用户组、公共）各三项动作（读取、写入、执行），
 * 排成「动作 × 三类人」的矩阵而不是三个并列盒子——勾选与三位八进制逐位对应，
 * 每列表头直接写出该位的当前数值，勾完一眼就能读出 755 这个模式是怎么来的。
 *
 * 勾选与「权限位」输入框是同一份状态的两个视图：勾选即时改写数值，数值合法时也即时回写勾选。
 * 所有者的候选是本机系统账号（含 root），与安全区的账号数据集同源。
 * 「应用到子目录」只在目录上出现：文件没有子目录，摆一个不起作用的开关是噪音。
 */

/**
 * 勾选格：20px 的小方框，勾上用淡色底加描边表达「开」，不用实心大色块——
 * 九个格子同屏，实心块会反过来压过内容本身。
 * align-top 是必需的：inline 盒按基线系（middle 也要量 x 字高）对齐都依赖字体度量，
 * 只有 top 对齐的参照是行盒顶部，与行高压平后按钮恰好占满、逐像素居中，勾选时也不会跳。
 */
const CELL_CLASS =
  'inline-flex size-5 items-center justify-center align-top rounded-md border transition-colors data-[state=checked]:border-accent/60 data-[state=checked]:bg-accent/10 data-[state=unchecked]:border-line data-[state=unchecked]:bg-surface-raised data-[state=unchecked]:hover:border-fg-subtle'

/** 勾选框里的对勾：勾上才渲染，颜色跟边框同调。 */
function CellCheck() {
  return (
    <Checkbox.Indicator className="text-accent">
      <Check aria-hidden size={12} strokeWidth={2.5} />
    </Checkbox.Indicator>
  )
}

export function PermissionDialog({
  entry,
  entryPath,
  onClose,
}: {
  entry: FileEntry
  entryPath: string
  onClose(): void
}) {
  const gateway = useGateway()
  const applyPermission = useFilesStore((s) => s.applyPermission)
  const [mode, setMode] = useState(entry.mode)
  const [modeText, setModeText] = useState(entry.mode)
  const [owner, setOwner] = useState(isValidHostUserName(entry.owner) ? entry.owner : 'root')
  const [recursive, setRecursive] = useState(false)
  const [ownerNames, setOwnerNames] = useState<readonly string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()

  const isDirectory = entry.kind === 'directory'
  // 解析不出账号名的属主（uid 数字串，挂载卷/overlay 文件常见）：改属主要过主机账号判据，
  // 这样的值必然被拒，不进候选也不作默认值——默认回落 root，实际属主仍显示在列表里。
  const currentOwnerSelectable = isValidHostUserName(entry.owner)

  // 换条目就重置表单：对话框复用同一份组件状态。
  useEffect(() => {
    setMode(entry.mode)
    setModeText(entry.mode)
    setOwner(currentOwnerSelectable ? entry.owner : 'root')
    setRecursive(false)
    setErrorMessage(undefined)
  }, [entry.mode, entry.owner, entryPath, currentOwnerSelectable])

  // 所有者候选：root 打头，其余系统账号按名称排序；当前所有者必在候选里，即使它已不在账号表中。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const users = await gateway.users.list()
        if (!cancelled) setOwnerNames(users.map((user) => user.name))
      } catch {
        // 取不到账号表不影响改权限：候选退化成「root 加当前所有者」。
        if (!cancelled) setOwnerNames([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [gateway])

  const ownerOptions = useMemo(() => {
    // 候选只收主机账号名（root 打头、系统账号排序）；当前属主解析不出名字时（uid 数字串）不进候选。
    const names = new Set(['root', ...ownerNames, ...(currentOwnerSelectable ? [entry.owner] : [])])
    return [...names].sort((a, b) => (a === 'root' ? -1 : b === 'root' ? 1 : a.localeCompare(b)))
  }, [ownerNames, entry.owner, currentOwnerSelectable])

  const permission = modeToPermission(mode)
  // 每列表头显示的位值：与下面那列勾选同源，勾选一变位值就变。
  const classDigits = permissionToMode(permission).split('')

  const toggle = (permissionClass: FilePermissionClass, action: FilePermissionAction) => {
    const next: FilePermission = {
      ...permission,
      [permissionClass]: {
        ...permission[permissionClass],
        [action]: !permission[permissionClass][action],
      },
    }
    const nextMode = permissionToMode(next)
    setMode(nextMode)
    setModeText(nextMode)
  }

  const submit = async () => {
    if (!isValidFileMode(modeText)) {
      setErrorMessage('权限位要写三位八进制数字，例如 755')
      return
    }
    setSubmitting(true)
    setErrorMessage(undefined)
    try {
      await applyPermission(gateway, entryPath, {
        mode: modeText,
        owner,
        recursive: isDirectory && recursive,
      })
      onClose()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '修改权限失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface-raised p-5 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">修改权限</Dialog.Title>
          {/* 路径跟着标题走：看清正在改哪一个条目，名字之外还有它在哪。 */}
          <p className="mt-1 truncate font-mono text-xs text-fg-muted" title={entryPath}>
            {entryPath}
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {/* 矩阵：行是三项动作，列是三类人，列宽三等分；行列之间都有线，读哪一格不会串行。
                leading-5 把行高压到与勾选框同高：配合 align-top，按钮恰好占满行盒、逐像素居中，
                不依赖字体度量（align-middle 对的是基线加半个 x 字高，天生差零点几像素）。 */}
            <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
              <table className="w-full table-fixed border-separate border-spacing-0 leading-5">
                <caption className="sr-only">权限设置：三类人各自的读取、写入与执行权限</caption>
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="w-[22%] border-b border-line px-3 py-2.5 text-left text-xs font-medium text-fg-subtle"
                    >
                      动作
                    </th>
                    {FILE_PERMISSION_CLASSES.map((permissionClass, index) => (
                      <th
                        key={permissionClass}
                        scope="col"
                        className="border-b border-l border-line px-3 py-2.5 text-center"
                      >
                        <span className="text-xs font-medium text-fg">
                          {FILE_PERMISSION_CLASS_LABELS[permissionClass]}
                        </span>
                        <span
                          className="ml-1.5 inline-flex min-w-4 justify-center rounded bg-surface-raised px-1 font-mono text-xs tabular-nums text-fg-muted"
                          title={`${FILE_PERMISSION_CLASS_LABELS[permissionClass]}的权限位`}
                        >
                          {classDigits[index]}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FILE_PERMISSION_ACTIONS.map((action) => (
                    <tr key={action}>
                      <th
                        scope="row"
                        className="border-b border-line px-3 py-2 text-left text-sm font-normal text-fg-muted"
                      >
                        {FILE_PERMISSION_ACTION_LABELS[action]}
                      </th>
                      {FILE_PERMISSION_CLASSES.map((permissionClass) => (
                        <td
                          key={permissionClass}
                          className="border-b border-l border-line px-3 py-2 text-center"
                        >
                          <Checkbox.Root
                            checked={permission[permissionClass][action]}
                            onCheckedChange={() => toggle(permissionClass, action)}
                            aria-label={`${FILE_PERMISSION_CLASS_LABELS[permissionClass]}${FILE_PERMISSION_ACTION_LABELS[action]}`}
                            className={CELL_CLASS}
                          >
                            <CellCheck />
                          </Checkbox.Root>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 控制行：权限位、所有者与应用范围同一基线排开，按钮靠右收在同一行，视线不用来回跳。 */}
            <div className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3 border-t border-line pt-4">
              <div>
                <label htmlFor="files-permission-mode" className="block text-xs text-fg-muted">
                  权限位
                </label>
                <input
                  id="files-permission-mode"
                  value={modeText}
                  onChange={(event) => {
                    const next = event.target.value
                    setModeText(next)
                    // 只在合法时回写勾选：输入途中的 '7' 不把面板清成空勾。
                    if (isValidFileMode(next)) setMode(next)
                  }}
                  inputMode="numeric"
                  className="mt-1.5 h-[34px] w-20 rounded-lg border border-line bg-surface px-2.5 text-center font-mono text-sm tabular-nums text-fg transition-colors hover:border-fg-subtle"
                />
              </div>

              <div className="min-w-32">
                <span id="files-permission-owner-label" className="block text-xs text-fg-muted">
                  所有者
                </span>
                <Select.Root value={owner} onValueChange={setOwner}>
                  <Select.Trigger
                    aria-labelledby="files-permission-owner-label"
                    className="mt-1.5 inline-flex h-[34px] w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 font-mono text-sm leading-none text-fg transition-colors hover:border-fg-subtle"
                  >
                    <Select.Value className="leading-none" />
                    <Select.Icon>
                      <ChevronDown aria-hidden size={14} className="shrink-0 text-fg-subtle" />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content
                      position="popper"
                      sideOffset={4}
                      className="z-[62] max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-surface p-1 text-xs shadow-lg"
                    >
                      <Select.Viewport>
                        {ownerOptions.map((name) => (
                          <Select.Item
                            key={name}
                            value={name}
                            className="flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 font-mono text-sm leading-none text-fg-muted outline-none data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                          >
                            <Select.ItemText>{name}</Select.ItemText>
                            <Select.ItemIndicator className="ml-auto inline-flex w-3.5 text-fg">
                              <Check aria-hidden size={13} />
                            </Select.ItemIndicator>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              {isDirectory ? (
                <label className="inline-flex h-[34px] cursor-pointer items-center gap-2 text-sm text-fg">
                  <Checkbox.Root
                    checked={recursive}
                    onCheckedChange={(checked) => setRecursive(checked === true)}
                    aria-label="应用到子目录"
                    className={CELL_CLASS}
                  >
                    <CellCheck />
                  </Checkbox.Root>
                  应用到子目录
                </label>
              ) : null}

              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-[34px] rounded-lg border border-line px-3 text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="h-[34px] rounded-lg border border-line bg-surface px-3 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
                >
                  应用
                </button>
              </div>
            </div>

            {errorMessage ? (
              <p role="alert" className="mt-2 text-xs text-danger">
                {errorMessage}
              </p>
            ) : null}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

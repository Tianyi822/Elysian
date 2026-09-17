import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import {
  WEBSITE_PROJECT_KINDS,
  WEBSITE_PROJECT_KIND_LABELS,
  isValidWebsiteProjectName,
  websiteProjectUsesPort,
} from '@elysian/contracts'
import type { WebsiteProjectKind } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { X } from '../../components/icons'
import { useWebsitesStore } from '../../stores/websitesStore'

/**
 * 添加项目弹窗：类型（五种运行时，分段选择）、名称、根目录（按名称自动带出、可改）、
 * 端口（仅 Java 与 Node 显示）、备注。新建即已停止、无证书：运行状态与证书不由表单决定，
 * 由演示引擎按需演进。提交失败（如同名项目已存在）保留弹窗，错误经通知条呈现。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'

export function WebsitesCreateDialog() {
  const gateway = useGateway()
  const saving = useWebsitesStore((s) => s.saving)
  const closeCreate = useWebsitesStore((s) => s.closeCreate)
  const createProject = useWebsitesStore((s) => s.createProject)

  const [kind, setKind] = useState<WebsiteProjectKind>('java')
  const [name, setName] = useState('')
  const [rootDir, setRootDir] = useState('')
  // 用户改过根目录后就不再自动带出：自动值只为省事，不能盖掉人工输入。
  const [rootDirTouched, setRootDirTouched] = useState(false)
  const [port, setPort] = useState('')
  const [note, setNote] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [portError, setPortError] = useState<string | undefined>(undefined)

  const usesPort = websiteProjectUsesPort(kind)

  const submit = () => {
    const trimmedName = name.trim()
    if (!isValidWebsiteProjectName(trimmedName)) {
      setNameError('项目名称需为 1-64 个字符')
      return
    }
    setNameError(undefined)
    let nextPort: number | undefined
    if (usesPort && port.trim()) {
      const parsed = Number(port)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        setPortError('端口需为 1-65535 的整数')
        return
      }
      setPortError(undefined)
      nextPort = parsed
    }
    void createProject(gateway, kind, {
      name: trimmedName,
      rootDir: rootDir.trim() || undefined,
      port: nextPort,
      note: note.trim() || null,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCreate() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「取消」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">添加项目</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                演示 · 待接入真实执行
              </span>
              <span className="text-sm font-medium text-fg">添加项目</span>
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
              <p className="mb-1 text-xs font-medium text-fg-muted">类型</p>
              <div
                role="group"
                aria-label="项目类型"
                className="flex flex-wrap gap-1.5"
              >
                {WEBSITE_PROJECT_KINDS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={option === kind}
                    onClick={() => setKind(option)}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      option === kind
                        ? 'border-accent/50 bg-accent/10 font-medium text-accent'
                        : 'border-line bg-surface-raised text-fg-muted hover:text-fg'
                    }`}
                  >
                    {WEBSITE_PROJECT_KIND_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="website-create-name" className="mb-1 block text-xs font-medium text-fg-muted">
                项目名称 <span className="text-danger">*</span>
              </label>
              <input
                id="website-create-name"
                value={name}
                onChange={(event) => {
                  const next = event.target.value
                  setName(next)
                  if (!rootDirTouched) setRootDir(`/www/wwwroot/${next.trim()}`)
                }}
                placeholder="如 订单中心-api"
                className={INPUT_CLASS}
              />
              {nameError ? <p className="mt-1 text-xs text-danger">{nameError}</p> : null}
            </div>

            <div>
              <label htmlFor="website-create-rootdir" className="mb-1 block text-xs font-medium text-fg-muted">
                根目录
              </label>
              <input
                id="website-create-rootdir"
                value={rootDir}
                onChange={(event) => {
                  setRootDirTouched(true)
                  setRootDir(event.target.value)
                }}
                placeholder="/www/wwwroot/项目名称"
                className={INPUT_CLASS}
              />
            </div>

            {usesPort ? (
              <div>
                <label htmlFor="website-create-port" className="mb-1 block text-xs font-medium text-fg-muted">
                  端口
                </label>
                <input
                  id="website-create-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder="如 8080"
                  className={`${INPUT_CLASS} tabular-nums`}
                />
                {portError ? <p className="mt-1 text-xs text-danger">{portError}</p> : null}
              </div>
            ) : null}

            <div>
              <label htmlFor="website-create-note" className="mb-1 block text-xs font-medium text-fg-muted">
                备注
              </label>
              <input
                id="website-create-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="选填，说明这个项目的用途"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <p className="text-xs text-fg-subtle">只改演示内存，不触碰真实站点。</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => closeCreate()}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={saving}
                className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
              >
                添加项目
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import {
  WEBSITE_PROJECT_KINDS,
  WEBSITE_PROJECT_KIND_LABELS,
  WEBSITE_RUNTIME_VERSIONS,
  isValidWebsitePort,
  isValidWebsiteProjectName,
  parseProjectNameFromGitUrl,
  websiteProjectUsesRuntime,
} from '@elysian/contracts'
import type { WebsiteProjectKind, WebsiteRuntimeKind } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Minus, Plus, X } from '../../components/icons'
import { useWebsitesStore } from '../../stores/websitesStore'
import { SelectDropdown } from '../../components/SelectDropdown'

/**
 * 添加项目弹窗：类型、Git 地址（可贴链接自动带出名称）、名称、运行时版本（非 HTML）、
 * 端口（自定义加减，全类型必填）、备注。根目录固定由名称推导，创建表单不暴露。
 * 提交失败保留弹窗，错误经通知条呈现。本期 Git 只存地址，不真拉代码。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'

const DEFAULT_PORT = 8080

function defaultRuntimeVersion(kind: WebsiteProjectKind): string | null {
  if (!websiteProjectUsesRuntime(kind)) return null
  return WEBSITE_RUNTIME_VERSIONS[kind as WebsiteRuntimeKind][0] ?? null
}

/** 自定义端口控件：文本输入 + 加减按钮，不使用浏览器 type=number 的系统步进。 */
function PortStepper({
  id,
  value,
  onChange,
}: {
  id: string
  value: number
  onChange: (next: number) => void
}) {
  const clamp = (next: number) => Math.min(65535, Math.max(1, next))
  return (
    <div className="flex items-stretch gap-1.5">
      <button
        type="button"
        aria-label="端口减一"
        onClick={() => onChange(clamp(value - 1))}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg"
      >
        <Minus aria-hidden size={14} />
      </button>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        onChange={(event) => {
          const raw = event.target.value.replace(/\D/g, '')
          if (!raw) {
            onChange(1)
            return
          }
          onChange(clamp(Number(raw)))
        }}
        className={`${INPUT_CLASS} text-center tabular-nums`}
      />
      <button
        type="button"
        aria-label="端口加一"
        onClick={() => onChange(clamp(value + 1))}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg"
      >
        <Plus aria-hidden size={14} />
      </button>
    </div>
  )
}

export function WebsitesCreateDialog() {
  const gateway = useGateway()
  const saving = useWebsitesStore((s) => s.saving)
  const closeCreate = useWebsitesStore((s) => s.closeCreate)
  const createProject = useWebsitesStore((s) => s.createProject)

  const [kind, setKind] = useState<WebsiteProjectKind>('java')
  const [gitUrl, setGitUrl] = useState('')
  const [name, setName] = useState('')
  /** 最近一次由 Git URL 自动带出的名称；名称仍等于它时，换 URL 可继续覆盖。 */
  const [autoName, setAutoName] = useState<string | null>(null)
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(() => defaultRuntimeVersion('java'))
  const [port, setPort] = useState(DEFAULT_PORT)
  const [note, setNote] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [portError, setPortError] = useState<string | undefined>(undefined)
  const [versionError, setVersionError] = useState<string | undefined>(undefined)

  const usesRuntime = websiteProjectUsesRuntime(kind)

  const applyKind = (next: WebsiteProjectKind) => {
    setKind(next)
    setRuntimeVersion(defaultRuntimeVersion(next))
    setVersionError(undefined)
  }

  const applyGitUrl = (next: string) => {
    setGitUrl(next)
    const parsed = parseProjectNameFromGitUrl(next)
    if (!parsed) return
    if (!name.trim() || name === autoName) {
      setName(parsed)
      setAutoName(parsed)
      setNameError(undefined)
    }
  }

  const submit = () => {
    const trimmedName = name.trim()
    if (!isValidWebsiteProjectName(trimmedName)) {
      setNameError('项目名称需为 1-64 个字符')
      return
    }
    setNameError(undefined)
    if (!isValidWebsitePort(port)) {
      setPortError('端口需为 1-65535 的整数')
      return
    }
    setPortError(undefined)
    if (usesRuntime && !runtimeVersion) {
      setVersionError('请选择运行时版本')
      return
    }
    setVersionError(undefined)
    void createProject(gateway, kind, {
      name: trimmedName,
      port,
      runtimeVersion: usesRuntime ? runtimeVersion : null,
      gitUrl: gitUrl.trim() || null,
      note: note.trim() || null,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCreate() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
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
              <div role="group" aria-label="项目类型" className="flex flex-wrap gap-1.5">
                {WEBSITE_PROJECT_KINDS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={option === kind}
                    onClick={() => applyKind(option)}
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
              <label htmlFor="website-create-git" className="mb-1 block text-xs font-medium text-fg-muted">
                Git 地址
              </label>
              <input
                id="website-create-git"
                value={gitUrl}
                onChange={(event) => applyGitUrl(event.target.value)}
                placeholder="如 https://github.com/org/repo.git"
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-xs text-fg-subtle">
                演示：只记录地址，代码将落到固定目录（详情页可见），不触碰真实仓库。
              </p>
            </div>

            <div>
              <label htmlFor="website-create-name" className="mb-1 block text-xs font-medium text-fg-muted">
                项目名称 <span className="text-danger">*</span>
              </label>
              <input
                id="website-create-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setAutoName(null)
                }}
                placeholder="如 订单中心-api"
                className={INPUT_CLASS}
              />
              {nameError ? <p className="mt-1 text-xs text-danger">{nameError}</p> : null}
            </div>

            {usesRuntime ? (
              <div>
                <p className="mb-1 text-xs font-medium text-fg-muted">
                  运行时版本 <span className="text-danger">*</span>
                </p>
                <SelectDropdown
                  ariaLabel="运行时版本"
                  fullWidth
                  items={WEBSITE_RUNTIME_VERSIONS[kind as WebsiteRuntimeKind].map((version) => ({
                    value: version,
                    label: version,
                  }))}
                  value={runtimeVersion ?? undefined}
                  onSelect={(next) => {
                    setRuntimeVersion(next)
                    setVersionError(undefined)
                  }}
                  fallbackLabel="请选择版本"
                />
                {versionError ? <p className="mt-1 text-xs text-danger">{versionError}</p> : null}
              </div>
            ) : null}

            <div>
              <label htmlFor="website-create-port" className="mb-1 block text-xs font-medium text-fg-muted">
                端口 <span className="text-danger">*</span>
              </label>
              <PortStepper id="website-create-port" value={port} onChange={setPort} />
              {portError ? <p className="mt-1 text-xs text-danger">{portError}</p> : null}
            </div>

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

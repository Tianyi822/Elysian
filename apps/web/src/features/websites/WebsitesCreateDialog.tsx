import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import {
  WEBSITE_PROJECT_KINDS,
  WEBSITE_PROJECT_KIND_LABELS,
  isValidWebsiteDomain,
  isValidWebsitePort,
  isValidWebsiteProjectName,
  parseProjectNameFromGitUrl,
  websiteProjectUsesRuntime,
} from '@elysian/contracts'
import type { WebsiteProjectKind, WebsiteRuntimeKind, WebsiteRuntimeCatalog, WebsiteRuntimeCatalogReport } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { Minus, Plus, X } from '../../components/icons'
import { useWebsitesStore } from '../../stores/websitesStore'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'

/**
 * 添加项目弹窗：类型、Git 地址（可贴链接自动带出名称）、名称、运行时版本（非 HTML）、
 * 端口（自定义加减，全类型必填）、Caddy 就绪时的访问方式与证书、备注。Caddy 未就绪
 * 时固定直连并隐藏访问方式区域。根目录固定由名称推导，Git 只登记地址，不自动拉取代码。
 */

const INPUT_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`

const DEFAULT_PORT = 8080

function defaultRuntimeVersion(kind: WebsiteProjectKind, catalog?: WebsiteRuntimeCatalog): string | null {
  if (!websiteProjectUsesRuntime(kind)) return null
  return catalog?.[kind as WebsiteRuntimeKind][0]?.version ?? null
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
        className={`inline-flex ${FORM_CONTROL_HEIGHT_CLASS} w-[34px] shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg`}
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
        className={`inline-flex ${FORM_CONTROL_HEIGHT_CLASS} w-[34px] shrink-0 items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-muted transition-colors hover:border-fg-subtle hover:text-fg`}
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
  const caddyReady = useDependencyGuideStore((s) => s.report?.caddy.state === 'ok')

  const [kind, setKind] = useState<WebsiteProjectKind>('java')
  const [gitUrl, setGitUrl] = useState('')
  const [name, setName] = useState('')
  /** 最近一次由 Git URL 自动带出的名称；名称仍等于它时，换 URL 可继续覆盖。 */
  const [autoName, setAutoName] = useState<string | null>(null)
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null)
  const [runtimeReport, setRuntimeReport] = useState<WebsiteRuntimeCatalogReport>()
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [runtimeError, setRuntimeError] = useState<string>()
  const [runtimeAttempt, setRuntimeAttempt] = useState(0)
  const [port, setPort] = useState(DEFAULT_PORT)
  const [domain, setDomain] = useState('')
  const [selectedAccessMode, setAccessMode] = useState<'direct' | 'domain'>('direct')
  // 报告变化也立即回落直连，避免隐藏的域名选项阻止提交或进入创建请求。
  const accessMode = caddyReady ? selectedAccessMode : 'direct'
  const [certificatePem, setCertificatePem] = useState('')
  const [privateKeyPem, setPrivateKeyPem] = useState('')
  const [certificateName, setCertificateName] = useState('')
  const [privateKeyName, setPrivateKeyName] = useState('')
  const [readingCertificate, setReadingCertificate] = useState(false)
  const [readingPrivateKey, setReadingPrivateKey] = useState(false)
  const certificateReadVersion = useRef(0)
  const privateKeyReadVersion = useRef(0)
  const [command, setCommand] = useState('')
  const [note, setNote] = useState('')
  const [nameError, setNameError] = useState<string | undefined>(undefined)
  const [portError, setPortError] = useState<string | undefined>(undefined)
  const [versionError, setVersionError] = useState<string | undefined>(undefined)
  const [domainError, setDomainError] = useState<string | undefined>(undefined)
  const [accessError, setAccessError] = useState<string | undefined>(undefined)
  const [commandError, setCommandError] = useState<string | undefined>(undefined)

  const usesRuntime = websiteProjectUsesRuntime(kind)
  const runtimeEntries = usesRuntime ? runtimeReport?.catalog[kind as WebsiteRuntimeKind] ?? [] : []

  useEffect(() => {
    const abort = new AbortController()
    setRuntimeLoading(true)
    setRuntimeError(undefined)
    void gateway.websites.runtimeCatalog(abort.signal).then((report) => {
      if (!abort.signal.aborted) setRuntimeReport(report)
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setRuntimeError(error instanceof Error ? error.message : '正式版本目录获取失败')
    }).finally(() => {
      if (!abort.signal.aborted) setRuntimeLoading(false)
    })
    return () => abort.abort()
  }, [gateway, runtimeAttempt])

  useEffect(() => {
    const entries = kind === 'html' ? [] : runtimeReport?.catalog[kind] ?? []
    setRuntimeVersion((previous) => entries.some((entry) => entry.version === previous) ? previous : defaultRuntimeVersion(kind, runtimeReport?.catalog))
  }, [kind, runtimeReport])

  const applyKind = (next: WebsiteProjectKind) => {
    setKind(next)
    setRuntimeVersion(defaultRuntimeVersion(next, runtimeReport?.catalog))
    setCommand('')
    setVersionError(undefined)
  }

  const applyPort = (next: number) => {
    setPort(next)
    setPortError(undefined)
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
    if (!command.trim() && kind !== 'html') { setCommandError('请填写容器启动命令'); return }
    setCommandError(undefined)
    const trimmedDomain = domain.trim()
    if (accessMode === 'domain' && !isValidWebsiteDomain(trimmedDomain)) {
      setDomainError('域名无效')
      return
    }
    setDomainError(undefined)
    if (accessMode === 'domain' && !caddyReady) { setAccessError('Caddy 管理通道不可用，请先安装或重新检测'); return }
    if (accessMode === 'domain' && (!certificatePem || !privateKeyPem)) { setAccessError('请同时上传公开 CA 证书链和私钥'); return }
    setAccessError(undefined)
    void createProject(gateway, kind, {
      name: trimmedName,
      port,
      runtimeVersion: usesRuntime ? runtimeVersion : null,
      access: accessMode === 'direct' ? { mode: 'direct' } : { mode: 'domain', domain: trimmedDomain, certificatePem, privateKeyPem },
      command: kind === 'html' ? null : command.trim(),
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
            <span className="text-sm font-medium text-fg">添加项目</span>
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
                只登记地址，不自动拉取代码；站点目录与运行环境创建后由你部署产物。
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
                <label htmlFor="website-create-runtime-version" className="mb-1 block text-xs font-medium text-fg-muted">
                  运行时版本 <span className="text-danger">*</span>
                </label>
                <SelectDropdown
                  key={kind}
                  id="website-create-runtime-version"
                  ariaLabel="运行时版本"
                  fullWidth
                  items={runtimeEntries.map((entry) => ({ value: entry.version, label: entry.version }))}
                  search={{ ariaLabel: '搜索运行时版本', placeholder: '搜索版本号（包含历史补丁）' }}
                  value={runtimeVersion ?? undefined}
                  onSelect={(next) => {
                    setRuntimeVersion(next)
                    setVersionError(undefined)
                  }}
                  fallbackLabel={runtimeVersion ?? '请选择版本'}
                  emptyLabel="没有匹配的正式版本"
                  disabled={runtimeLoading || Boolean(runtimeError)}
                />
                {versionError ? <p className="mt-1 text-xs text-danger">{versionError}</p> : null}
                {runtimeLoading ? <p role="status" className="mt-1 text-xs text-fg-muted">正在从官方获取正式版本…</p> : null}
                {runtimeError ? <div role="alert" className="mt-1 text-xs text-danger">{runtimeError}<button type="button" className="ml-2 underline" onClick={() => setRuntimeAttempt((attempt) => attempt + 1)}>重新获取</button></div> : null}
                {!runtimeLoading && !runtimeError ? <p className="mt-1 text-xs text-fg-subtle">共 {runtimeEntries.length} 个正式版本，包含历史补丁</p> : null}
                {runtimeReport?.detail ? <p role="status" className="mt-1 text-xs text-warning">{runtimeReport.detail}</p> : null}
              </div>
            ) : null}

            <div>
              <label htmlFor="website-create-port" className="mb-1 block text-xs font-medium text-fg-muted">
                端口 <span className="text-danger">*</span>
              </label>
              <PortStepper id="website-create-port" value={port} onChange={applyPort} />
              {portError ? <p className="mt-1 text-xs text-danger">{portError}</p> : null}
            </div>

            <div>
              <label htmlFor="website-create-command" className="mb-1 block text-xs font-medium text-fg-muted">启动命令 {kind !== 'html' ? <span className="text-danger">*</span> : null}</label>
              <input id="website-create-command" value={kind === 'html' ? 'Nginx 默认命令' : command} disabled={kind === 'html'} onChange={(event) => { setCommand(event.target.value); setCommandError(undefined) }} placeholder={kind === 'java' ? '如 java -jar app.jar' : kind === 'node' ? '如 node app.js' : kind === 'go' ? '如 ./server --port 8080' : kind === 'python' ? `如 python3 -m http.server ${port} --bind 0.0.0.0 --directory /app` : ''} className={INPUT_CLASS} />
              {commandError ? <p className="mt-1 text-xs text-danger">{commandError}</p> : <p className="mt-1 text-xs text-fg-subtle">命令作为 Docker 参数执行，不经宿主 Shell；服务需监听容器内 0.0.0.0。</p>}
            </div>

            {caddyReady ? <div>
              <p className="mb-2 text-xs font-medium text-fg-muted">访问方式</p>
              <div role="group" aria-label="访问方式" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button type="button" aria-pressed={accessMode === 'direct'} onClick={() => { setAccessMode('direct'); setAccessError(undefined) }} className={`rounded-lg border p-3 text-left text-xs ${accessMode === 'direct' ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted'}`}><strong className="block">IP＋端口直连</strong><span>HTTP · 无需证书</span></button>
                <button type="button" aria-pressed={accessMode === 'domain'} onClick={() => { setAccessMode('domain'); setAccessError(undefined) }} className={`rounded-lg border p-3 text-left text-xs ${accessMode === 'domain' ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted'}`}><strong className="block">域名访问</strong><span>HTTPS · 需自备公开 CA 证书</span></button>
              </div>
              {accessMode === 'domain' ? <div className="mt-3 space-y-2">
                <label htmlFor="website-create-domain" className="block text-xs text-fg-muted">访问域名 *</label>
                <input id="website-create-domain" value={domain} onChange={(event) => { setDomain(event.target.value); setDomainError(undefined) }} placeholder="www.example.com" className={INPUT_CLASS} />
                {domainError ? <p className="text-xs text-danger">{domainError}</p> : null}
                <label className="block text-xs text-fg-muted">PEM 证书链 *<input type="file" accept=".pem,.crt,.cer" className="mt-1 block w-full text-xs" onChange={(event) => { const file = event.target.files?.[0]; if (file) { const version = ++certificateReadVersion.current; setCertificateName(file.name); setCertificatePem(''); setReadingCertificate(true); void file.text().then((pem) => { if (version === certificateReadVersion.current) setCertificatePem(pem) }).catch(() => { if (version === certificateReadVersion.current) setAccessError('证书文件读取失败') }).finally(() => { if (version === certificateReadVersion.current) setReadingCertificate(false) }) } }} /></label>
                <label className="block text-xs text-fg-muted">PEM 私钥 *<input type="file" accept=".pem,.key" className="mt-1 block w-full text-xs" onChange={(event) => { const file = event.target.files?.[0]; if (file) { const version = ++privateKeyReadVersion.current; setPrivateKeyName(file.name); setPrivateKeyPem(''); setReadingPrivateKey(true); void file.text().then((pem) => { if (version === privateKeyReadVersion.current) setPrivateKeyPem(pem) }).catch(() => { if (version === privateKeyReadVersion.current) setAccessError('私钥文件读取失败') }).finally(() => { if (version === privateKeyReadVersion.current) setReadingPrivateKey(false) }) } }} /></label>
                <p className="text-xs text-fg-subtle">{certificateName && privateKeyName ? `已选择 ${certificateName}、${privateKeyName}` : '证书和私钥仅用于当前项目；续期时需重新上传。'}</p>
              </div> : null}
              {accessError ? <p role="alert" className="mt-2 text-xs text-danger">{accessError}</p> : null}
              <p className="mt-3 rounded-lg border border-line p-2 text-xs text-fg-muted">访问路径：{accessMode === 'direct' ? `http://服务器IP:${port} → 项目容器` : `https://${domain.trim() || '域名'} → Caddy → 项目容器`}</p>
              <p className="mt-1 text-xs text-fg-subtle">{accessMode === 'direct' ? `创建时将自动在防火墙开放端口 ${port}；DNS 与公网可达性请自行核对。` : '域名访问经宿主 Caddy 的 80/443，这两个端口请在安全页确认开放；DNS 与公网可达性请自行核对。'}</p>
            </div> : null}

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

          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
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
                disabled={saving || (usesRuntime && (runtimeLoading || Boolean(runtimeError) || !runtimeVersion)) || (accessMode === 'domain' && (readingCertificate || readingPrivateKey))}
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

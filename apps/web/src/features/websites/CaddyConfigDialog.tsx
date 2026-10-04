import * as Dialog from '@radix-ui/react-dialog'
import { useRef, useState } from 'react'
import { isValidWebsiteDomain, type WebsiteAccessInput, type WebsiteProject } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { X } from '../../components/icons'
import { useDependencyGuideStore } from '../../stores/dependencyGuideStore'
import { useWebsitesStore } from '../../stores/websitesStore'

const SECTION = 'panel-surface p-4'
const ACTION = 'rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-fg hover:border-fg-subtle disabled:opacity-50'
const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg'

function statusLabel(project: WebsiteProject): string {
  if (project.accessMode === 'direct') return 'IP＋端口直连'
  if (!project.routeApplied || !project.certificate?.applied) return '待下发'
  return project.runState === 'stopped' ? '路由和证书已下发，项目未运行' : '路由和证书已下发'
}

/** 同一窗口按选择项目、配置入口、预览路径、核对结果的顺序引导。 */
export function CaddyConfigDialog({ onClose, onAddProject }: { onClose: () => void; onAddProject: () => void }) {
  const gateway = useGateway()
  const projects = useWebsitesStore((s) => s.projects)
  const proxy = useWebsitesStore((s) => s.proxyStatus)
  const saveAccess = useWebsitesStore((s) => s.saveAccess)
  const refresh = useWebsitesStore((s) => s.refresh)
  const report = useDependencyGuideStore((s) => s.report)
  const rechecking = useDependencyGuideStore((s) => s.rechecking)
  const recheck = useDependencyGuideStore((s) => s.recheck)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'direct' | 'domain'>('direct')
  const [domain, setDomain] = useState('')
  const [certificatePem, setCertificatePem] = useState('')
  const [privateKeyPem, setPrivateKeyPem] = useState('')
  const [certificateName, setCertificateName] = useState('')
  const [privateKeyName, setPrivateKeyName] = useState('')
  const [readingCertificate, setReadingCertificate] = useState(false)
  const [readingPrivateKey, setReadingPrivateKey] = useState(false)
  const certificateReadVersion = useRef(0)
  const privateKeyReadVersion = useRef(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<WebsiteProject | null>(null)
  const selected = projects.find((project) => project.id === selectedId) ?? null
  const available = report?.caddy.state === 'ok' && proxy.state === 'active'
  const normalized = domain.trim().toLowerCase()
  const changed = selected !== null && (mode !== selected.accessMode || (mode === 'domain' && (normalized !== selected.domain || !!certificatePem)))
  const invalid = mode === 'domain' && !isValidWebsiteDomain(normalized)
  const needsCaddyToSave = mode === 'domain' || selected?.accessMode === 'domain'

  function select(project: WebsiteProject) {
    certificateReadVersion.current += 1
    privateKeyReadVersion.current += 1
    setSelectedId(project.id)
    setMode(project.accessMode)
    setDomain(project.domain ?? '')
    setCertificatePem('')
    setPrivateKeyPem('')
    setCertificateName('')
    setPrivateKeyName('')
    setReadingCertificate(false)
    setReadingPrivateKey(false)
    setError(null)
    setResult(null)
  }

  async function submit() {
    if (!selected || !changed || saving) return
    if (needsCaddyToSave && !available) { setError('Caddy 管理通道异常，原域名路由需要回收；请重新检测后保存'); return }
    if (invalid) { setError('域名无效，请填写 www.example.com 形式'); return }
    if (mode === 'domain' && (!!certificatePem !== !!privateKeyPem)) { setError('请同时上传证书链和私钥'); return }
    if (mode === 'domain' && !certificatePem && (!selected.certificate || selected.accessMode !== 'domain')) { setError('域名访问需要上传公开 CA 证书链和私钥'); return }
    const access: WebsiteAccessInput = mode === 'direct' ? { mode: 'direct' } : {
      mode: 'domain', domain: normalized,
      ...(certificatePem ? { certificatePem, privateKeyPem } : {}),
    }
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      const updated = await saveAccess(gateway, selected.id, access)
      setResult(updated)
      setMode(updated.accessMode)
      setDomain(updated.domain ?? '')
      setCertificatePem('')
      setPrivateKeyPem('')
      setCertificateName('')
      setPrivateKeyName('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '访问配置保存失败') }
    finally { setSaving(false) }
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <Dialog.Content aria-describedby="access-config-description" className="fixed left-1/2 top-1/2 z-[55] flex max-h-[calc(100vh-2rem)] w-[min(52rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div><Dialog.Title className="text-base font-semibold text-fg">访问配置</Dialog.Title><Dialog.Description id="access-config-description" className="mt-1 text-xs text-fg-muted">选择项目，再选择 IP 直连或域名 HTTPS 访问。</Dialog.Description></div>
          <Dialog.Close asChild><button type="button" aria-label="关闭访问配置" disabled={saving} className="rounded-lg p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"><X aria-hidden size={16} /></button></Dialog.Close>
        </div>
        <div className="space-y-4 overflow-y-auto p-4 sm:p-5">
          <div role="status" className={`${SECTION} text-xs ${available ? 'text-success' : 'text-warning'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><span>{available ? 'Caddy 管理通道已连接' : `Caddy 管理通道异常：${report?.caddy.detail ?? proxy.detail ?? '请重新检测'}`}</span>{!available ? <button type="button" disabled={rechecking} onClick={() => { void recheck(gateway).then(() => refresh(gateway)) }} className={ACTION}>{rechecking ? '正在检测…' : '重新检测'}</button> : null}</div>
            <p className="mt-1 text-fg-muted">IP＋端口直连不依赖 Caddy；域名访问需要 Caddy 与公开 CA 证书。</p>
          </div>
          <section className={SECTION}><h3 className="text-sm font-medium text-fg">1 选择项目</h3>
            {projects.length === 0 ? <div className="mt-3 text-xs text-fg-muted">暂无项目。<button type="button" onClick={onAddProject} className="ml-2 underline">先添加项目</button></div> :
              <div role="list" className="mt-3 grid max-h-40 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">{projects.map((project) => <button key={project.id} type="button" aria-pressed={selectedId === project.id} onClick={() => select(project)} className={`rounded-lg border p-2 text-left text-xs ${selectedId === project.id ? 'border-accent bg-accent/10' : 'border-line'}`}><strong className="block truncate text-fg">{project.name}</strong><span className="text-fg-muted">{statusLabel(project)}</span></button>)}</div>}
          </section>
          <section className={SECTION}><h3 className="text-sm font-medium text-fg">2 配置访问入口</h3>
            <div role="group" aria-label="访问方式" className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><button type="button" disabled={!selected} aria-pressed={mode === 'direct'} onClick={() => { setMode('direct'); setError(null); setResult(null) }} className={`${ACTION} text-left`}>IP＋端口直连<br /><span className="text-fg-muted">HTTP，无需证书</span></button><button type="button" disabled={!selected} aria-pressed={mode === 'domain'} onClick={() => { setMode('domain'); setError(null); setResult(null) }} className={`${ACTION} text-left`}>域名访问<br /><span className="text-fg-muted">HTTPS，需上传公开 CA 证书</span></button></div>
            {selected && mode === 'direct' ? <p className="mt-3 text-xs text-fg-muted">宿主端口 {selected.port} 将绑定所有网卡。切换访问方式需要重建容器，运行中的项目会短暂停机。</p> : null}
            {selected && mode === 'domain' ? <div className="mt-3 space-y-3">
              <div><label htmlFor="access-domain" className="block text-xs text-fg-muted">访问域名 *</label><input id="access-domain" value={domain} onChange={(event) => { setDomain(event.target.value); setResult(null) }} placeholder="www.example.com" className={`${INPUT} mt-1`} />{invalid ? <p className="mt-1 text-xs text-danger">域名格式无效</p> : null}</div>
              <label className="block text-xs text-fg-muted">PEM 证书链 {selected.certificate ? '（不更换可留空）' : '*'}<input type="file" accept=".pem,.crt,.cer" className="mt-1 block w-full" onChange={(event) => { const file = event.target.files?.[0]; if (file) { const version = ++certificateReadVersion.current; setCertificateName(file.name); setCertificatePem(''); setReadingCertificate(true); void file.text().then((pem) => { if (version === certificateReadVersion.current) setCertificatePem(pem) }).catch(() => { if (version === certificateReadVersion.current) setError('证书文件读取失败') }).finally(() => { if (version === certificateReadVersion.current) setReadingCertificate(false) }) } }} /></label>
              <label className="block text-xs text-fg-muted">PEM 私钥 {selected.certificate ? '（不更换可留空）' : '*'}<input type="file" accept=".pem,.key" className="mt-1 block w-full" onChange={(event) => { const file = event.target.files?.[0]; if (file) { const version = ++privateKeyReadVersion.current; setPrivateKeyName(file.name); setPrivateKeyPem(''); setReadingPrivateKey(true); void file.text().then((pem) => { if (version === privateKeyReadVersion.current) setPrivateKeyPem(pem) }).catch(() => { if (version === privateKeyReadVersion.current) setError('私钥文件读取失败') }).finally(() => { if (version === privateKeyReadVersion.current) setReadingPrivateKey(false) }) } }} /></label>
              {certificateName || privateKeyName ? <p className="text-xs text-fg-subtle">已选择 {certificateName || '未选证书'}、{privateKeyName || '未选私钥'}</p> : null}
              {selected.certificate ? <p className="text-xs text-fg-muted">当前证书有效至 {selected.certificate.notAfter.slice(0, 10)}；更换域名时，原证书必须覆盖新域名。</p> : null}
            </div> : null}
          </section>
          <section className={SECTION}><h3 className="text-sm font-medium text-fg">3 预览访问路径</h3><p className="mt-2 break-all text-xs text-fg">{selected ? mode === 'direct' ? `http://服务器IP:${selected.port} → ${selected.name} 容器` : `https://${normalized || '域名'} → Caddy → ${selected.name} 容器` : '选择项目后显示访问路径'}</p><p className="mt-2 text-xs text-fg-muted">{mode === 'direct' && selected ? `保存后将自动在防火墙开放端口 ${selected.port}；公网 IP 与 DNS 请自行核对。` : '请自行核对公网 IP、DNS 指向和防火墙端口（80/443 归宿主 Caddy）；这里不将公网可达性标为已通过。'}</p></section>
          <section className={SECTION}><h3 className="text-sm font-medium text-fg">4 保存并核对结果</h3><div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" disabled={!selected || !changed || saving || readingCertificate || readingPrivateKey || invalid || (needsCaddyToSave && !available)} onClick={() => { void submit() }} className={ACTION}>{saving ? '正在保存…' : '保存访问配置'}</button>{selected ? <span className="text-xs text-fg-muted">当前：{statusLabel(selected)}</span> : null}</div>{needsCaddyToSave && !available ? <p className="text-xs text-warning">域名路由需要 Caddy 回收或下发，通道恢复后可保存。</p> : null}{error ? <p role="alert" className="mt-3 text-xs text-danger">{error}</p> : null}{result ? <p role="status" className="mt-3 text-xs text-success">已保存：{statusLabel(result)}。{result.accessMode === 'domain' ? '请确认 DNS 与公网 80/443 可达，并在证书到期前重新上传。' : '请确认服务器 IP 和所选端口可达。'}</p> : null}</section>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

import { useEffect, useState } from 'react'
import type { AgentEmbeddingProfile } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { KeyRound } from '../../components/icons'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MemoryDialog } from './MemoryDialog'

/*
 * Embedding 配置表单：新建与编辑共用。凭据只写不回显——编辑时留空沿用旧凭据，
 * 服务端只返回 hasCredential；增改均无 requestId（单飞锁）。维度 1..8192。
 */
export function MemoryEmbeddingFormDialog({
  profile,
  onClose,
}: {
  profile?: AgentEmbeddingProfile
  onClose(): void
}) {
  const gateway = useGateway()
  const createProfile = useAgentMemoryStore((state) => state.createEmbeddingProfile)
  const updateProfile = useAgentMemoryStore((state) => state.updateEmbeddingProfile)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [name, setName] = useState(profile?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '')
  const [model, setModel] = useState(profile?.model ?? '')
  const [dimensions, setDimensions] = useState(String(profile?.dimensions ?? 1536))
  const [active, setActive] = useState(profile?.active ?? false)
  const [credential, setCredential] = useState('')
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    setName(profile?.name ?? '')
    setBaseUrl(profile?.baseUrl ?? '')
    setModel(profile?.model ?? '')
    setDimensions(String(profile?.dimensions ?? 1536))
    setActive(profile?.active ?? false)
    setCredential('')
    setErrorMessage(undefined)
  }, [profile])

  const submit = async () => {
    const parsedDimensions = Number(dimensions)
    if (!Number.isSafeInteger(parsedDimensions) || parsedDimensions < 1 || parsedDimensions > 8192) {
      setErrorMessage('维度必须是 1 到 8192 的整数')
      return
    }
    await inFlightOnly(async () => {
      try {
        if (profile === undefined) {
          await createProfile(gateway, {
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            dimensions: parsedDimensions,
            active,
            ...(credential === '' ? {} : { credential }),
          })
        } else {
          await updateProfile(gateway, profile.id, {
            expectedRevision: profile.revision,
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            model: model.trim(),
            dimensions: parsedDimensions,
            active,
            ...(credential === '' ? {} : { credential }),
          })
        }
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存 Embedding 配置失败')
      }
    })
  }

  return (
    <MemoryDialog
      title={profile === undefined ? '新建 Embedding 配置' : `编辑「${profile.name}」（修订 ${profile.revision}）`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="memory-embedding-name" className="block text-xs text-fg-muted">名称</label>
            <input id="memory-embedding-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg" />
          </div>
          <div>
            <label htmlFor="memory-embedding-model" className="block text-xs text-fg-muted">模型标识</label>
            <input id="memory-embedding-model" value={model} onChange={(event) => setModel(event.target.value)} maxLength={200} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="memory-embedding-baseurl" className="block text-xs text-fg-muted">服务地址（HTTP/HTTPS，不带凭据/查询/片段）</label>
            <input id="memory-embedding-baseurl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg" />
            <p className="mt-1 text-xs text-fg-subtle">明文 HTTP 地址携带凭据时仅允许本机回环。</p>
          </div>
          <div>
            <label htmlFor="memory-embedding-dimensions" className="block text-xs text-fg-muted">向量维度（1..8192）</label>
            <input id="memory-embedding-dimensions" type="number" min={1} max={8192} value={dimensions} onChange={(event) => setDimensions(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm tabular-nums text-fg" />
          </div>
          <fieldset className="mt-5">
            <legend className="text-xs text-fg-muted">启用状态</legend>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
              启用（搜索按 ID 最小的启用配置尝试向量检索）
            </label>
          </fieldset>
          <div className="sm:col-span-2">
            <label htmlFor="memory-embedding-credential" className="block text-xs text-fg-muted">
              凭据（只写不回显{profile !== undefined && profile.hasCredential ? '；留空沿用已保存凭据' : ''}）
            </label>
            <div className="relative mt-1">
              <KeyRound aria-hidden size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" />
              <input
                id="memory-embedding-credential"
                type="password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                autoComplete="new-password"
                className="h-9 w-full rounded-lg border border-line bg-surface px-3 pl-8 font-mono text-sm text-fg"
              />
            </div>
            {profile !== undefined && profile.hasCredential ? (
              <p className="mt-1 text-xs text-fg-subtle">服务端已保存凭据（仅回显 hasCredential）。</p>
            ) : null}
          </div>
        </div>
        {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
          <button type="submit" disabled={submitting} className={CTL_PRIMARY}>
            {profile === undefined ? '创建配置' : '保存新修订'}
          </button>
        </div>
      </form>
    </MemoryDialog>
  )
}

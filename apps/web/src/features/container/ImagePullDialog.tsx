import * as Dialog from '@radix-ui/react-dialog'
import { Gauge, X } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { useEffect, useId, useRef, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useContainersStore } from '../../stores/containersStore'
import type { RegistryProbeResult } from '../../contracts/adapters'
import { readStoredImageRegistry, writeStoredImageRegistry } from './imagePullPreferences'
import { CUSTOM_REGISTRY_ID, IMAGE_REGISTRY_PRESETS, matchRegistryPreset } from './imageRegistryPresets'
import {
  DEFAULT_IMAGE_REGISTRY,
  isOfficialImageRegistry,
  parseImageReference,
  registryHost,
  validateRegistryUrl,
} from './imageReference'

/**
 * 拉取镜像弹窗：镜像源预设下拉（含自定义地址兜底与逐项测速）+ 镜像引用两个输入，
 * 格式与查重行内提示，有效引用实时预览完整拉取路径。提交后弹窗立即关闭，拉取中行与
 * 完成通知在镜像列表里呈现；Docker 运行时为真实拉取，演示模式只作记录。
 * 测速只由点击触发、结果不持久化：速度是时点事实，持久化就是过期的谎言。
 */

const INPUT_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-control-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`
const FIELD_LABEL_CLASS = 'mb-2 block text-xs font-medium text-fg-muted'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'

/** 测速耗时展示：1 秒内给毫秒，其余保留一位小数秒。 */
function formatProbeDuration(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

export function ImagePullDialog({ onClose }: { onClose: () => void }) {
  const gateway = useGateway()
  const images = useContainersStore((s) => s.images)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const pullImage = useContainersStore((s) => s.pullImage)

  const docker = isDockerRuntime()

  const [presetId, setPresetId] = useState<string>(() => matchRegistryPreset(readStoredImageRegistry())?.id ?? CUSTOM_REGISTRY_ID)
  const [customAddress, setCustomAddress] = useState(readStoredImageRegistry)
  const [reference, setReference] = useState('')
  const [suggestions, setSuggestions] = useState<readonly string[]>([])
  const [suggestionStatus, setSuggestionStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const requestSerial = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [tags, setTags] = useState<readonly string[]>([])
  const [tagStatus, setTagStatus] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  const tagRequestSerial = useRef(0)
  const tagAbortRef = useRef<AbortController | null>(null)
  const [probes, setProbes] = useState<Record<string, { busy: boolean; result?: RegistryProbeResult }>>({})
  const probeAbortRef = useRef<Map<string, AbortController>>(new Map())
  const [probeNotice, setProbeNotice] = useState<string | null>(null)
  const listId = useId()

  const isCustomPreset = presetId === CUSTOM_REGISTRY_ID
  const registryAddress = isCustomPreset
    ? customAddress
    : IMAGE_REGISTRY_PRESETS.find((preset) => preset.id === presetId)?.url ?? ''

  // 留空即默认官方地址；非空才校验格式。
  const registry = registryAddress.trim() || DEFAULT_IMAGE_REGISTRY
  const registryError = registryAddress.trim() ? validateRegistryUrl(registryAddress) : undefined
  const searchTerm = reference.trim().split(':')[0] ?? ''
  const hasRegistryInput = registryAddress.trim() !== ''
  const parsed = parseImageReference(reference)
  const tagRepository = parsed.ok && !parsed.reference.name.includes(':') ? parsed.reference.name : ''
  const searchUnavailableMessage = suggestionStatus === 'unavailable'
    ? isOfficialImageRegistry(registryAddress)
      ? '镜像名称搜索暂不可用，请直接输入镜像名；版本列表会单独查询。'
      : '此镜像源的名称搜索不可用，请直接输入镜像名；版本列表会单独查询。'
    : null

  useEffect(() => { writeStoredImageRegistry(registryAddress) }, [registryAddress])

  const stopProbe = (id: string) => {
    probeAbortRef.current.get(id)?.abort()
    probeAbortRef.current.delete(id)
  }

  const runProbe = (id: string, url: string) => {
    const host = registryHost(url)
    if (!host || validateRegistryUrl(url)) return
    stopProbe(id)
    const controller = new AbortController()
    probeAbortRef.current.set(id, controller)
    setProbes((current) => ({ ...current, [id]: { busy: true, result: current[id]?.result } }))
    setProbeNotice(`正在测速 ${host}…`)
    void gateway.containers.probeRegistry(host, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setProbes((current) => ({ ...current, [id]: { busy: false, result } }))
        setProbeNotice(result.ok
          ? `测速完成：${host} 下载 1 MiB 用时 ${formatProbeDuration(result.elapsedMs ?? 0)}`
          : `测速失败：${host} ${result.reason ?? '不可达'}`)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setProbes((current) => ({ ...current, [id]: { busy: false, result: { ok: false, reason: '测速请求失败' } } }))
        setProbeNotice(`测速失败：${host} 测速请求失败`)
      })
  }

  useEffect(() => {
    const pending = probeAbortRef.current
    return () => { pending.forEach((controller) => controller.abort()) }
  }, [])

  useEffect(() => {
    const serial = ++tagRequestSerial.current
    tagAbortRef.current?.abort()
    tagAbortRef.current = null
    setTags([])
    if (tagRepository.length < 2 || registryError) {
      setTagStatus('idle')
      return
    }
    setTagStatus('loading')
    const controller = new AbortController()
    tagAbortRef.current = controller
    const timer = setTimeout(() => {
      void gateway.containers.imageTags(tagRepository, hasRegistryInput ? registryAddress.trim() : undefined, controller.signal)
        .then((result) => {
          if (serial !== tagRequestSerial.current || controller.signal.aborted) return
          setTags(result.tags)
          setTagStatus(result.searchable ? 'idle' : 'unavailable')
        })
        .catch(() => {
          if (serial !== tagRequestSerial.current || controller.signal.aborted) return
          setTags([])
          setTagStatus('unavailable')
        })
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [hasRegistryInput, gateway, registryAddress, registryError, tagRepository])

  const invalidateTags = () => {
    tagRequestSerial.current += 1
    tagAbortRef.current?.abort()
    setTags([])
    setTagStatus('idle')
  }

  useEffect(() => {
    const serial = ++requestSerial.current
    abortRef.current?.abort()
    abortRef.current = null
    if (searchTerm.length < 2 || registryError || suggestionsDismissed) {
      setSuggestions([])
      setSuggestionStatus('idle')
      setSuggestionsOpen(false)
      return
    }
    setSuggestions([])
    setSuggestionStatus('loading')
    const controller = new AbortController()
    abortRef.current = controller
    const timer = setTimeout(() => {
      void gateway.containers.searchImageNames(searchTerm, hasRegistryInput ? registryAddress.trim() : undefined, controller.signal)
        .then((result) => {
          if (serial !== requestSerial.current || controller.signal.aborted) return
          setSuggestions(result.names)
          setActiveSuggestion(0)
          setSuggestionStatus(result.searchable ? 'idle' : 'unavailable')
          setSuggestionsOpen(result.searchable && result.names.length > 0)
        })
        .catch(() => {
          if (serial !== requestSerial.current || controller.signal.aborted) return
          setSuggestions([])
          setSuggestionsOpen(false)
          setSuggestionStatus('unavailable')
        })
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [hasRegistryInput, gateway, registryAddress, registryError, searchTerm, suggestionsDismissed])

  const invalidateSuggestions = () => {
    requestSerial.current += 1
    abortRef.current?.abort()
    setSuggestions([])
    setSuggestionsOpen(false)
    setSuggestionStatus('idle')
    setSuggestionsDismissed(false)
  }

  const chooseSuggestion = (name: string) => {
    invalidateSuggestions()
    if (name !== tagRepository) invalidateTags()
    setReference(`${name}:latest`)
    setSuggestionsDismissed(true)
  }

  const duplicate =
    parsed.ok && images.some((i) => i.name === parsed.reference.name && i.tag === parsed.reference.tag)
  const referenceError = !parsed.ok
    ? parsed.error
    : duplicate
      ? `镜像已存在：${parsed.reference.name}:${parsed.reference.tag}`
      : undefined
  // 单字段实时提示：引用输入为空时不出错也不预览。
  const showReferenceError = reference.trim() !== '' && Boolean(referenceError)

  const invalid = Boolean(registryError) || Boolean(referenceError)
  const preview =
    parsed.ok && !duplicate && !registryError
      ? `${registryHost(registry)}/${parsed.reference.name}:${parsed.reference.tag}`
      : undefined
  const currentTag = parsed.ok ? parsed.reference.tag : undefined
  const tagItems = currentTag === undefined
    ? []
    : [
        ...(tags.includes(currentTag) ? [] : [{ value: currentTag, label: `${currentTag}（当前输入）` }]),
        ...tags.map((tag) => ({ value: tag, label: tag })),
      ]

  const submit = () => {
    if (invalid || !parsed.ok || duplicate) return
    onClose()
    void pullImage(gateway, { ...parsed.reference, registry })
  }

  const probeTrailing = (id: string, url: string) => {
    const state = probes[id]
    const host = registryHost(url)
    const unusable = !host || Boolean(validateRegistryUrl(url))
    return (
      <>
        {state?.result ? (
          <span className={`text-xs tabular-nums ${state.result.ok ? 'text-fg-muted' : 'text-danger'}`}>
            {state.result.ok ? formatProbeDuration(state.result.elapsedMs ?? 0) : '不可用'}
          </span>
        ) : null}
        <IconButton
          label={unusable ? '测速：先填写有效地址' : `测速 ${host}`}
          variant="ghost"
          disabled={unusable}
          busy={state?.busy}
          onPress={() => runProbe(id, url)}
        >
          <Gauge aria-hidden size={13} />
        </IconButton>
      </>
    )
  }

  const sourceItems = [
    ...IMAGE_REGISTRY_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
      description: preset.note,
      trailing: probeTrailing(preset.id, preset.url),
    })),
    {
      value: CUSTOM_REGISTRY_ID,
      label: '自定义地址…',
      description: isCustomPreset && customAddress.trim() ? registryHost(customAddress) : undefined,
      trailing: probeTrailing(CUSTOM_REGISTRY_ID, customAddress),
    },
  ]

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(34rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">拉取镜像</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div className="flex items-center gap-2">
              {!docker ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              ) : null}
              <span className="text-sm font-semibold text-fg">拉取镜像</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <label htmlFor="pull-registry" className={FIELD_LABEL_CLASS}>
              镜像源
            </label>
            <SelectDropdown
              id="pull-registry"
              ariaLabel="镜像源"
              fullWidth
              mono
              items={sourceItems}
              value={presetId}
              onSelect={(next) => {
                invalidateSuggestions()
                invalidateTags()
                setProbeNotice(null)
                setPresetId(next)
              }}
            />
            {probeNotice ? <p role="status" className="mt-1.5 text-xs text-fg-muted">{probeNotice}</p> : null}
            <p className="mt-1.5 text-xs text-fg-subtle">
              {docker
                ? '测速下载 1 MiB 样本计时，结果只作本次参考；只支持公开镜像与公网镜像源'
                : '演示模式不访问真实镜像仓库，测速不可用；地址仅作记录，不产生真实数据流。'}
            </p>
            {isCustomPreset ? (
              <div className="mt-3">
                <label htmlFor="pull-registry-custom" className={FIELD_LABEL_CLASS}>
                  自定义镜像源地址
                </label>
                <input
                  id="pull-registry-custom"
                  value={customAddress}
                  onChange={(event) => { invalidateSuggestions(); invalidateTags(); setCustomAddress(event.target.value) }}
                  placeholder="留空使用官方地址 registry-1.docker.io"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={registryError ? 'pull-registry-error' : undefined}
                  className={`${INPUT_CLASS} font-mono`}
                />
                {registryError ? (
                  <p className={FIELD_ERROR_CLASS} id="pull-registry-error">
                    {registryError}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4">
              <label htmlFor="pull-reference" className={FIELD_LABEL_CLASS}>
                镜像引用
              </label>
              <input
                id="pull-reference"
                value={reference}
                onChange={(event) => {
                  invalidateSuggestions()
                  const next = parseImageReference(event.target.value)
                  if (!next.ok || next.reference.name !== tagRepository) invalidateTags()
                  setReference(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && suggestionsOpen) {
                    event.preventDefault()
                    event.stopPropagation()
                    setSuggestionsOpen(false)
                  } else if (suggestionsOpen && event.key === 'ArrowDown') {
                    event.preventDefault()
                    setActiveSuggestion((index) => (index + 1) % suggestions.length)
                  } else if (suggestionsOpen && event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveSuggestion((index) => (index - 1 + suggestions.length) % suggestions.length)
                  } else if (suggestionsOpen && event.key === 'Enter') {
                    event.preventDefault()
                    chooseSuggestion(suggestions[activeSuggestion]!)
                  }
                }}
                onFocus={() => { if (suggestions.length > 0) setSuggestionsOpen(true) }}
                placeholder="例如 redis:8-alpine，标签缺省为 latest"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggestionsOpen}
                aria-controls={listId}
                aria-activedescendant={suggestionsOpen ? `${listId}-${activeSuggestion}` : undefined}
                aria-describedby={showReferenceError ? 'pull-reference-error' : undefined}
                className={`${INPUT_CLASS} font-mono`}
              />
              {suggestionsOpen ? (
                <div id={listId} role="listbox" aria-label="镜像名称建议" className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-control-line bg-surface-raised p-1 shadow-lg">
                  {suggestions.map((name, index) => (
                    <button key={name} id={`${listId}-${index}`} type="button" role="option" aria-selected={activeSuggestion === index}
                      onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(name)}
                      className={`block w-full rounded px-2 py-1.5 text-left font-mono text-xs text-fg hover:bg-surface ${activeSuggestion === index ? 'bg-surface' : ''}`}>
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
              {suggestionStatus === 'loading' ? <p role="status" className="mt-1 text-xs text-fg-subtle">正在搜索镜像…</p> : null}
              {searchUnavailableMessage ? <p role="status" className="mt-1 text-xs text-fg-muted">{searchUnavailableMessage}</p> : null}
              {showReferenceError ? (
                <p className={FIELD_ERROR_CLASS} id="pull-reference-error">
                  {referenceError}
                </p>
              ) : null}
            </div>

            <div className="mt-4">
              <label htmlFor="pull-tag" className={FIELD_LABEL_CLASS}>版本标签</label>
              <SelectDropdown
                key={`${registryAddress}|${tagRepository}`}
                id="pull-tag"
                ariaLabel="版本标签"
                fullWidth
                items={tagItems}
                value={currentTag}
                fallbackLabel="先输入镜像名称"
                disabled={!parsed.ok || tags.length === 0}
                onSelect={(tag) => {
                  if (parsed.ok) setReference(`${parsed.reference.name}:${tag}`)
                }}
              />
              {tagStatus === 'loading' ? <p role="status" className="mt-1 text-xs text-fg-subtle">正在查询可用版本…</p> : null}
              {tagStatus === 'unavailable' ? <p role="status" className="mt-1 text-xs text-fg-muted">无法列出此镜像的版本，可换镜像源或在镜像引用中手动输入标签</p> : null}
              {tagStatus === 'idle' && tags.length > 0 ? <p className="mt-1 text-xs text-fg-subtle">已查询到版本，可选择后拉取，也可手动修改标签。</p> : null}
              {tagStatus === 'idle' && tagRepository.length >= 2 && tags.length === 0 ? <p className="mt-1 text-xs text-fg-subtle">此源未返回版本，可换镜像源或在镜像引用中手动输入标签。</p> : null}
            </div>

            {preview ? (
              <div className="mt-4 rounded-lg border border-control-line bg-surface-raised px-3 py-2">
                <p className="text-xs text-fg-subtle">将拉取</p>
                <p className="mt-0.5 break-all font-mono text-sm text-fg">{preview}</p>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-xs text-fg-subtle">
              {docker
                ? '从镜像仓库拉取，只支持公开镜像。'
                : '拉取由演示数据模拟，不访问真实镜像仓库。'}
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={invalid || Boolean(pullingImage)}
                className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pullingImage ? '拉取中…' : '拉取'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

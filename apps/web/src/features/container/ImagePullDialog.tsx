import * as Dialog from '@radix-ui/react-dialog'
import { X } from '../../components/icons'
import { useEffect, useId, useRef, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useContainersStore } from '../../stores/containersStore'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import {
  DEFAULT_IMAGE_REGISTRY,
  isOfficialImageRegistry,
  parseImageReference,
  registryHost,
  validateRegistryUrl,
} from './imageReference'

/**
 * 拉取镜像弹窗：拉取源 + 镜像引用两个输入，格式与查重行内提示，
 * 有效引用实时预览完整拉取路径。提交后弹窗立即关闭，拉取中行与
 * 完成通知在镜像列表里呈现；Docker 运行时为真实拉取，演示模式只作记录。
 */

const INPUT_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-control-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`
const FIELD_LABEL_CLASS = 'mb-2 block text-xs font-medium text-fg-muted'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'

export function ImagePullDialog({ onClose }: { onClose: () => void }) {
  const gateway = useGateway()
  const images = useContainersStore((s) => s.images)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const pullImage = useContainersStore((s) => s.pullImage)

  const docker = isDockerRuntime()

  const [registryAddress, setRegistryAddress] = useState('')
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
  const listId = useId()

  // 留空即默认官方地址；非空才校验格式。
  const registry = registryAddress.trim() || DEFAULT_IMAGE_REGISTRY
  const registryError = registryAddress.trim() ? validateRegistryUrl(registryAddress) : undefined
  const searchTerm = reference.trim().split(':')[0] ?? ''
  const hasRegistryInput = registryAddress.trim() !== ''
  const parsed = parseImageReference(reference)
  const tagRepository = parsed.ok && !parsed.reference.name.includes(':') ? parsed.reference.name : ''
  const searchUnavailableMessage = suggestionStatus === 'unavailable'
    ? isOfficialImageRegistry(registryAddress) ? '镜像搜索暂不可用，请直接输入镜像引用' : '无法从此镜像源搜索，请直接输入镜像引用'
    : null
  useFeedbackNotification(searchUnavailableMessage, 'warning')
  useFeedbackNotification(tagStatus === 'unavailable' ? '无法列出此镜像的版本，可在镜像引用中手动输入标签' : null, 'warning')

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
              自定义镜像源地址
            </label>
            <input
              id="pull-registry"
              value={registryAddress}
              onChange={(event) => { invalidateSuggestions(); invalidateTags(); setRegistryAddress(event.target.value) }}
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
            <p className="mt-1.5 text-xs text-fg-subtle">
              {docker
                ? '未填写时从官方 Docker Hub 拉取；只支持公开镜像与公网镜像源'
                : '未填写时从官方 Docker Hub 地址拉取；地址仅作记录，不产生真实数据流。'}
            </p>

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
              {tagStatus === 'unavailable' ? <p role="status" className="mt-1 text-xs text-fg-muted">无法列出此镜像的版本，可在镜像引用中手动输入标签</p> : null}
              {tagStatus === 'idle' && tags.length > 0 ? <p className="mt-1 text-xs text-fg-subtle">选择版本后仍可在镜像引用中修改标签。</p> : null}
              {tagStatus === 'idle' && tagRepository.length >= 2 && tags.length === 0 ? <p className="mt-1 text-xs text-fg-subtle">暂无可选版本，可在镜像引用中手动输入标签。</p> : null}
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

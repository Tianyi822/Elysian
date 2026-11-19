import { useEffect, useId, useRef, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useImeEnterGuard } from '../../components/useImeEnterGuard'
import type { ImageRegistryPreset, RegistryProbeResult } from '../../contracts/adapters'
import { useContainersStore } from '../../stores/containersStore'
import { readStoredImageRegistry, writeStoredImageRegistry } from '../../utils/imagePullPreferences'
import { DEFAULT_IMAGE_REGISTRY, isOfficialImageRegistry, parseImageReference, registryHost, validateRegistryUrl } from '../../utils/imageReference'
import { CUSTOM_REGISTRY_ID, matchRegistryPreset } from '../../utils/imageRegistryPresets'

/** 测速耗时展示：1 秒内给毫秒，其余保留一位小数秒。 */
export function formatProbeDuration(ms: number): string {
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

export function useImagePullForm(onClose: () => void) {
  const gateway = useGateway()
  const images = useContainersStore((s) => s.images)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const pullImage = useContainersStore((s) => s.pullImage)

  const [presets, setPresets] = useState<readonly ImageRegistryPreset[]>([])
  const [directoryError, setDirectoryError] = useState(false)
  const [directoryLoading, setDirectoryLoading] = useState(true)
  const [directoryVersion, setDirectoryVersion] = useState(0)
  const [registryAddress, setRegistryAddress] = useState(() => readStoredImageRegistry() || DEFAULT_IMAGE_REGISTRY)
  const [forceCustom, setForceCustom] = useState(false)
  const presetId = forceCustom ? CUSTOM_REGISTRY_ID : matchRegistryPreset(presets, registryAddress)?.id ?? CUSTOM_REGISTRY_ID
  const [customAddress, setCustomAddress] = useState(readStoredImageRegistry)
  const [reference, setReference] = useState('')
  const { guardProps, isImeKey } = useImeEnterGuard()
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

  useEffect(() => {
    const controller = new AbortController()
    setDirectoryError(false)
    setDirectoryLoading(true)
    void gateway.containers.listRegistryPresets(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setPresets(items) })
      .catch(() => { if (!controller.signal.aborted) setDirectoryError(true) })
      .finally(() => { if (!controller.signal.aborted) setDirectoryLoading(false) })
    return () => controller.abort()
  }, [gateway, directoryVersion])

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

  const selectRegistry = (next: string) => {
    invalidateSuggestions()
    invalidateTags()
    setProbeNotice(null)
    setForceCustom(next === CUSTOM_REGISTRY_ID)
    setRegistryAddress(next === CUSTOM_REGISTRY_ID ? customAddress : presets.find((preset) => preset.id === next)?.url ?? registryAddress)
  }

  const changeCustomAddress = (value: string) => {
    invalidateSuggestions()
    invalidateTags()
    setForceCustom(true)
    setCustomAddress(value)
    setRegistryAddress(value)
  }

  const changeReference = (value: string) => {
    invalidateSuggestions()
    const next = parseImageReference(value)
    if (!next.ok || next.reference.name !== tagRepository) invalidateTags()
    setReference(value)
  }

  const selectTag = (tag: string) => {
    if (parsed.ok) setReference(`${parsed.reference.name}:${tag}`)
  }

  return {
    invalid, pullingImage, submit, preview,
    registry: {
      presets, presetId, isCustomPreset, registryAddress, registryError, customAddress, directoryError, directoryLoading,
      probeNotice, probes, runProbe, selectRegistry, changeCustomAddress,
      retryDirectory: () => setDirectoryVersion((value) => value + 1),
    },
    reference: {
      reference, changeReference, guardProps, isImeKey, suggestions, suggestionsOpen, setSuggestionsOpen,
      activeSuggestion, setActiveSuggestion, chooseSuggestion, listId, suggestionStatus,
      searchUnavailableMessage, showReferenceError, referenceError,
    },
    tags: { tagRepository, currentTag, tagItems, tags, tagStatus, selectTag, tagDisabled: !parsed.ok || tags.length === 0 },
  }
}

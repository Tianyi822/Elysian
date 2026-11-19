import { Button } from '../../components/Button'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { IconButton } from '../../components/IconButton'
import { Gauge } from '../../components/icons'
import { SearchInput } from '../../components/SearchInput'
import { SelectDropdown } from '../../components/SelectDropdown'
import { registryHost, validateRegistryUrl } from '../../utils/imageReference'
import { CUSTOM_REGISTRY_ID } from '../../utils/imageRegistryPresets'
import { formatProbeDuration, type useImagePullForm } from './useImagePullForm'

const INPUT_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-control-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`
const FIELD_LABEL_CLASS = 'mb-2 block text-xs font-medium text-fg-muted'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'

export function ImagePullFields({ form, docker }: { form: ReturnType<typeof useImagePullForm>; docker: boolean }) {
  const { preview } = form
  const {
    presets, presetId, isCustomPreset, registryAddress, registryError, customAddress, directoryError, directoryLoading,
    probeNotice, probes, runProbe, selectRegistry, changeCustomAddress, retryDirectory,
  } = form.registry
  const {
    reference, changeReference, guardProps, isImeKey, suggestions, suggestionsOpen, setSuggestionsOpen,
    activeSuggestion, setActiveSuggestion, chooseSuggestion, listId, suggestionStatus,
    searchUnavailableMessage, showReferenceError, referenceError,
  } = form.reference
  const { tagRepository, currentTag, tagItems, tags, tagStatus, selectTag, tagDisabled } = form.tags

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
    ...presets.map((preset) => ({
      value: preset.id,
      label: preset.label,
      description: preset.note,
      trailing: probeTrailing(preset.id, preset.url),
    })),
    {
      value: CUSTOM_REGISTRY_ID,
      label: '自定义地址…',
      description: isCustomPreset && customAddress.trim() ? registryHost(customAddress) : undefined,
      trailing: probeTrailing(CUSTOM_REGISTRY_ID, isCustomPreset ? registryAddress : customAddress),
    },
  ]

  return (
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
        onSelect={selectRegistry}
      />
      {directoryLoading ? <p role="status" className="mt-1.5 text-xs text-fg-muted">正在读取镜像源…</p> : null}
      {!directoryLoading && !directoryError && presets.length === 0 ? <p className="mt-1.5 text-xs text-fg-muted">暂无预设，可填写自定义地址。</p> : null}
      {directoryError ? <p role="alert" className="mt-1.5 text-xs text-danger">镜像源目录读取失败，当前地址仍可使用。<Button variant="link" type="button" className="ml-2 underline" onClick={retryDirectory}>重试目录</Button></p> : null}
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
            value={registryAddress}
            onChange={(event) => changeCustomAddress(event.target.value)}
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
        <SearchInput
          id="pull-reference"
          label="镜像引用"
          value={reference}
          onChange={changeReference}
          onClear={() => setSuggestionsOpen(false)}
          placeholder="例如 redis:8-alpine，标签缺省为 latest"
          expandOnFocus={false}
          className="w-full"
          inputProps={{
            ...guardProps,
            type: 'text',
            autoComplete: 'off',
            spellCheck: false,
            role: 'combobox',
            'aria-autocomplete': 'list',
            'aria-expanded': suggestionsOpen,
            'aria-controls': listId,
            'aria-activedescendant': suggestionsOpen ? `${listId}-${activeSuggestion}` : undefined,
            'aria-describedby': showReferenceError ? 'pull-reference-error' : undefined,
            className: 'font-mono',
            onFocus: () => { if (suggestions.length > 0) setSuggestionsOpen(true) },
            onKeyDown: (event) => {
              if (isImeKey(event)) return
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
            },
          }}
        />
        {suggestionsOpen ? (
          <div id={listId} role="listbox" aria-label="镜像名称建议" className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-control-line bg-surface-raised p-1 shadow-lg">
            {suggestions.map((name, index) => (
              <Button unstyled key={name} id={`${listId}-${index}`} type="button" role="option" aria-selected={activeSuggestion === index}
                onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(name)}
                className={`block w-full rounded px-2 py-1.5 text-left font-mono text-xs text-fg hover:bg-surface ${activeSuggestion === index ? 'bg-surface' : ''}`}>
                {name}
              </Button>
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
          disabled={tagDisabled}
          onSelect={selectTag}
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
  )
}

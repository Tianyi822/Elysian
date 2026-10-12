import { useEffect, useState } from 'react'
import type { AgentMemoryPage, AgentMemoryPageInput, AgentMemoryPageKind } from '@elysian/contracts'
import { AGENT_MEMORY_PAGE_KINDS, AGENT_MEMORY_PAGE_KIND_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { validateMemoryPageInput } from '../../adapters/http/agent/agentMemoryHttpAdapter'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { formatMarkdownBytes, markdownExceedsLimit } from './memoryLabels'
import { MemoryDialog } from './MemoryDialog'

/*
 * Wiki 页面编辑器（新建/编辑共用）。正文 Markdown 按 16 KiB 字节计数并在超限时
 * 前端拦截；evidence 与 sources 由提炼流程维护，编辑器只读回显数量（≤32/≤64）。
 * 提交走 Input 体：编辑时 expectedRevision 放进请求体（不是查询参数），建页不带。
 */

const KIND_ITEMS = AGENT_MEMORY_PAGE_KINDS.map((kind) => ({ value: kind, label: AGENT_MEMORY_PAGE_KIND_LABELS[kind] }))

function toIso(value: string): string | undefined {
  if (value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function fromIso(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return ''
  const date = new Date(parsed)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function splitList(value: string): string[] {
  return value.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== '')
}

export function MemoryPageFormDialog({
  spaceId,
  page,
  onClose,
}: {
  spaceId: string
  page?: AgentMemoryPage
  onClose(): void
}) {
  const gateway = useGateway()
  const createPage = useAgentMemoryStore((state) => state.createPage)
  const updatePage = useAgentMemoryStore((state) => state.updatePage)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [slug, setSlug] = useState(page?.slug ?? '')
  const [title, setTitle] = useState(page?.title ?? '')
  const [kind, setKind] = useState<AgentMemoryPageKind | undefined>(page?.kind)
  const [markdown, setMarkdown] = useState(page?.markdown ?? '')
  const [expiresAt, setExpiresAt] = useState(fromIso(page?.expiresAt))
  const [tags, setTags] = useState((page?.tags ?? []).join('，'))
  const [aliases, setAliases] = useState((page?.aliases ?? []).join('，'))
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    setSlug(page?.slug ?? '')
    setTitle(page?.title ?? '')
    setKind(page?.kind)
    setMarkdown(page?.markdown ?? '')
    setExpiresAt(fromIso(page?.expiresAt))
    setTags((page?.tags ?? []).join('，'))
    setAliases((page?.aliases ?? []).join('，'))
    setErrorMessage(undefined)
  }, [page])

  const oversized = markdownExceedsLimit(markdown)

  const submit = async () => {
    const input: AgentMemoryPageInput = {
      slug: slug.trim(),
      title: title.trim(),
      markdown,
      ...(kind === undefined ? {} : { kind }),
      ...(expiresAt === '' ? {} : { expiresAt: toIso(expiresAt) }),
      evidence: page?.evidence ?? [],
      sources: page?.sources ?? [],
      tags: splitList(tags),
      aliases: splitList(aliases),
      ...(page === undefined ? {} : { expectedRevision: page.revision }),
    }
    try {
      validateMemoryPageInput(input)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Wiki 页面内容无效')
      return
    }
    await inFlightOnly(async () => {
      try {
        if (page === undefined) await createPage(gateway, spaceId, input)
        else await updatePage(gateway, spaceId, page.id, input)
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存 Wiki 页面失败')
      }
    })
  }

  return (
    <MemoryDialog
      title={page === undefined ? '新建 Wiki 页面' : `编辑「${page.title}」（当前修订 ${page.revision}）`}
      onClose={onClose}
      width="w-[min(44rem,calc(100vw-2rem))]"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="memory-page-slug" className="block text-xs text-fg-muted">slug（小写字母、数字与 . _ / -）</label>
            <input
              id="memory-page-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              readOnly={page !== undefined}
              maxLength={128}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg read-only:text-fg-muted"
            />
            {page !== undefined ? <p className="mt-1 text-xs text-fg-subtle">slug 随页面固定，修订不改动。</p> : null}
          </div>
          <div>
            <label htmlFor="memory-page-title" className="block text-xs text-fg-muted">标题</label>
            <input
              id="memory-page-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={512}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
            />
          </div>
          <div>
            <span id="memory-page-kind-label" className="block text-xs text-fg-muted">类型</span>
            <div className="mt-1">
              <SelectDropdown
                ariaLabel="页面类型"
                items={KIND_ITEMS}
                value={kind}
                onSelect={setKind}
                fallbackLabel="参考资料（默认）"
                fullWidth
              />
            </div>
          </div>
          <div>
            <label htmlFor="memory-page-expires" className="block text-xs text-fg-muted">有效期（可空；观测类默认 30 天）</label>
            <input
              id="memory-page-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
            />
          </div>
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <label htmlFor="memory-page-markdown" className="block text-xs text-fg-muted">正文（Markdown）</label>
            <span className={`text-xs tabular-nums ${oversized ? 'text-danger' : 'text-fg-subtle'}`}>
              {formatMarkdownBytes(markdown)}
            </span>
          </div>
          <textarea
            id="memory-page-markdown"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            rows={12}
            aria-describedby="memory-page-markdown-hint"
            className="mt-1 w-full rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-5 text-fg"
          />
          <p id="memory-page-markdown-hint" className="mt-1 text-xs text-fg-subtle">
            正文按字节计不超过 16 KiB；用 [[页面 ID]] 建立链接。页面内容按不可信资料保存与渲染。
          </p>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="memory-page-tags" className="block text-xs text-fg-muted">标签（逗号分隔，至多 32 项）</label>
            <input
              id="memory-page-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
            />
          </div>
          <div>
            <label htmlFor="memory-page-aliases" className="block text-xs text-fg-muted">别名（逗号分隔，至多 32 项）</label>
            <input
              id="memory-page-aliases"
              value={aliases}
              onChange={(event) => setAliases(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
            />
          </div>
        </div>
        <p className="mt-3 text-xs text-fg-subtle">
          证据 {page?.evidence.length ?? 0}/32 条、来源 {page?.sources.length ?? 0}/64 条由提炼流程维护，本次提交按现状透传。
        </p>
        {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
          <button type="submit" disabled={submitting || oversized} className={CTL_PRIMARY}>
            {page === undefined ? '创建页面' : '保存为新修订'}
          </button>
        </div>
      </form>
    </MemoryDialog>
  )
}

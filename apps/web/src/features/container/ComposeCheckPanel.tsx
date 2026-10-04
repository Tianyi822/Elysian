import type { ComposeReference } from '@elysian/contracts'
import { COMPOSE_REFERENCE_KIND_LABELS } from '@elysian/contracts'
import { Check, CircleCheck, Copy, Loader2, TriangleAlert, X } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { RefreshButton } from '../../components/RefreshState'
import { useClipboardCopy } from '../../components/CopyButton'
import type { ComposeCheckState } from '../../stores/containerAppsStore'

/**
 * compose 引用路径自检结果。
 *
 * 自检是保守的行扫描而不是 YAML 解析，所以 coverage（判定了什么）与
 * undetermined（判定不了的行）必须和结论同屏出现——把局部判定显示成全量结论，
 * 比不做检查更容易坑人。每条引用回显拼接后的绝对路径，缺哪个文件就抄那条路径。
 */

/** 引用拼成可直接抄进 compose 的绝对路径；`./` 自身就落在 compose 目录里。 */
function referenceAbsolute(ref: ComposeReference): string {
  const scope = ref.scope.replace(/\/+$/, '')
  return ref.path ? `${scope}/${ref.path}` : scope
}

function ReferenceRow({ reference }: { reference: ComposeReference }) {
  const { copied, copy } = useClipboardCopy()
  const absolute = referenceAbsolute(reference)

  return (
    <li className="rounded-lg border border-line bg-surface px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="tabular-nums text-fg-subtle">第 {reference.line} 行</span>
        <span className="rounded border border-line px-1.5 py-0.5 text-fg-muted">
          {COMPOSE_REFERENCE_KIND_LABELS[reference.kind]}
        </span>
        <span className="min-w-0 truncate font-mono text-fg" title={reference.raw}>
          {reference.raw}
        </span>
        <span
          className={`ml-auto inline-flex items-center gap-1 ${reference.exists ? 'text-fg-muted' : 'font-medium text-warning'}`}
        >
          {reference.exists ? (
            <CircleCheck aria-hidden size={13} className="text-success" />
          ) : (
            <TriangleAlert aria-hidden size={13} />
          )}
          {reference.exists ? '工作区内已存在' : '工作区内找不到'}
        </span>
      </div>
      {/* 绝对路径单独一行：改 compose 要抄的就是它， truncate 时 tooltip 与复制都拿全值。 */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle" title={absolute}>
          {absolute}
        </code>
        <button
          type="button"
          onClick={() => void copy(absolute, '引用真实路径')}
          title={copied ? '已复制该引用的真实绝对路径' : '复制该引用的真实绝对路径'}
          aria-label="复制该引用的真实绝对路径"
          className="icon-button inline-flex size-6 shrink-0 items-center justify-center text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg"
        >
          {copied ? <Check aria-hidden size={13} className="text-success" /> : <Copy aria-hidden size={13} />}
        </button>
      </div>
    </li>
  )
}

export function ComposeCheckPanel({
  check,
  onRerun,
  onClose,
}: {
  check: ComposeCheckState
  onRerun: () => void
  onClose: () => void
}) {
  const missing = check.result?.references.filter((ref) => !ref.exists) ?? []

  return (
    <section
      aria-label="compose 路径自检"
      className="mt-3 rounded-lg border border-line bg-surface-raised/50 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
          compose 自检 · <span className="font-mono">{check.path}</span>
        </h3>
        <RefreshButton
          label="重新自检"
          variant="ghost"
          onPress={onRerun}
          busy={check.loading}
          className="size-6"
        />
        <IconButton label="收起自检结果" variant="ghost" tone="neutral" onPress={onClose}>
          <X aria-hidden size={14} />
        </IconButton>
      </div>

      {check.loading ? (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-fg-muted">
          <Loader2 aria-hidden size={13} className="animate-spin" />
          正在扫描引用路径…
        </p>
      ) : check.error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          自检失败：{check.error}
        </p>
      ) : check.result ? (
        <>
          <p
            role="status"
            className={`mt-2 text-xs ${missing.length > 0 ? 'font-medium text-warning' : 'text-fg-muted'}`}
          >
            {check.result.references.length === 0
              ? '未发现可判定的相对路径引用。'
              : missing.length === 0
                ? `${check.result.references.length} 条路径引用全部落在工作区内。`
                : `${check.result.references.length} 条路径引用中，${missing.length} 条在工作区内找不到对应文件。`}
          </p>

          {check.result.references.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {check.result.references.map((reference) => (
                <ReferenceRow key={`${reference.line}:${reference.raw}`} reference={reference} />
              ))}
            </ul>
          ) : null}

          {check.result.undetermined.length > 0 ? (
            <div className="mt-2.5">
              <p className="text-xs font-medium text-fg-muted">以下引用面板判定不了，请人工核对</p>
              <ul className="mt-1 space-y-0.5">
                {check.result.undetermined.map((text) => (
                  <li key={text} className="break-all font-mono text-xs text-warning">
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-2.5 text-xs text-fg-subtle">判定范围：{check.result.coverage}</p>
        </>
      ) : null}
    </section>
  )
}

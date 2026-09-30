import * as Dialog from '@radix-ui/react-dialog'
import { useRef } from 'react'
import {
  LOG_SHARD_MAX_BYTES,
  PLATFORM_LOG_CATEGORY_LABELS,
  formatLogBytes,
  logRetentionText,
} from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { formatLoginTime } from '../../components/format'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'

/**
 * 清空日志的二次确认：破坏性动作要用户再点一次，并逐字写明清空之后不可恢复。
 *
 * 数字口径：文件数、体积、最早时间都是**打开弹窗时最近一次加载的 storage 快照**
 * （写入洪水下与真正删掉的东西可能不一致，所以文案带「最近一次刷新时」这句限定），
 * 体积一律走契约的 formatLogBytes，不手写「256 MB」这类会与保留说明分叉的文案；
 * 真正的删除结果以清空响应为准，完成后用通知展示实际数字。
 */
export function ClearLogsDialog() {
  const gateway = useGateway()
  const contentRef = useRef<HTMLDivElement>(null)
  const clearTarget = useRuntimeLogStore((s) => s.clearTarget)
  const clearing = useRuntimeLogStore((s) => s.clearing)
  const storage = useRuntimeLogStore((s) => s.storage)
  const closeClear = useRuntimeLogStore((s) => s.closeClear)
  const clear = useRuntimeLogStore((s) => s.clear)

  if (!clearTarget) return null

  const label = PLATFORM_LOG_CATEGORY_LABELS[clearTarget]
  // 运行日志面板的存储快照里，运行日志自己的字节数是 runtimeBytes。
  const totalBytes = storage?.runtimeBytes ?? 0
  const fileCount = storage?.rowCount ?? 0
  const oldestAt = storage?.oldestAt ?? null

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) closeClear() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60" />
        <Dialog.Content
          ref={contentRef}
          // 容器可聚焦 + 接管打开时的自动聚焦：初始焦点不落在「确认清空」上，
          // Tab 的第一站因此是顺序在前的「取消」。
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus()
          }}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">{`确认清空${label}？`}</Dialog.Title>
          {/* 正文是必读信息：aria-describedby 指向它（Radix 默认启用，不要关掉）。 */}
          <Dialog.Description asChild>
            <div className="mt-1.5 space-y-1.5 text-xs text-fg-muted">
              <p>
                {`将删除服务器上${label}的全部日志文件（含已压缩的分片与临时残留）。最近一次刷新时：共 ${fileCount} 个文件、约 ${formatLogBytes(totalBytes)}。`}
              </p>
              <p>
                日志最早可追溯到
                {oldestAt ? ` ${formatLoginTime(oldestAt)}` : ' ——（当前没有日志）'}。
              </p>
              <p>
                {`${label}${logRetentionText(clearTarget)}；单个文件超过 ${formatLogBytes(LOG_SHARD_MAX_BYTES)} 会自动分片。`}
              </p>
              <p className="font-medium text-danger">
                清空后无法恢复，也不会留下备份；系统服务自己的日志（如 sshd.log）不受影响。
              </p>
              {isDockerRuntime() ? null : (
                <p>演示数据：只清空内存中的演示日志，不触碰任何文件。</p>
              )}
            </div>
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => closeClear()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              disabled={clearing}
              onClick={() => void clear(gateway)}
              className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-50"
            >
              {clearing ? '清空中…' : '确认清空'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

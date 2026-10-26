import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'
import { useNotificationStore } from '../../stores/notificationStore'
import {
  buildExportFilename,
  buildExportPayload,
  downloadJson,
  FIREWALL_EXPORT_DIRECTIONS,
} from './firewallRuleIO'
import type { FirewallExportDirection } from './firewallRuleIO'

/**
 * 导出端口规则弹窗：按方向（所有/入站/出站）筛出规则，生成 JSON 文件在本地下载。
 * 文件在浏览器本地生成，不发网络请求；导出的是当前规则集，格式与导入互通。
 */
export function FirewallExportDialog() {
  const rules = useFirewallStore((s) => s.rules)
  const closeExport = useFirewallStore((s) => s.closeExport)
  const [direction, setDirection] = useState<FirewallExportDirection>('all')

  const count = rules.filter((rule) => direction === 'all' || rule.direction === direction).length

  const submit = () => {
    const exportedAt = new Date().toISOString()
    downloadJson(buildExportFilename(direction, exportedAt), buildExportPayload(rules, direction, exportedAt))
    useNotificationStore.getState().notify({
      tone: 'info',
      message: `已导出${FIREWALL_EXPORT_DIRECTIONS.find((item) => item.value === direction)?.label}的 ${count} 条规则，文件已开始下载`,
    })
    closeExport()
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeExport() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">导出规则</Dialog.Title>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-sm font-medium text-fg">导出规则</span>
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

          <div className="px-4 py-4">
            <p className="mb-1 text-xs font-medium text-fg-muted">导出方向</p>
            <div
              role="group"
              aria-label="导出方向"
              className="inline-flex overflow-hidden rounded-lg border border-line"
            >
              {FIREWALL_EXPORT_DIRECTIONS.map(({ value, label }, index) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={direction === value}
                  onClick={() => setDirection(value)}
                  className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors ${
                    index > 0 ? 'border-l border-line' : ''
                  } ${
                    direction === value
                      ? 'bg-surface-raised font-medium text-fg'
                      : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-fg-subtle">
              将导出{FIREWALL_EXPORT_DIRECTIONS.find((item) => item.value === direction)?.label}
              的 <span className="font-medium tabular-nums text-fg">{count}</span> 条规则为 JSON 文件；文件在本机生成。
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-line px-4 py-2.5">
            <button
              type="button"
              onClick={() => closeExport()}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle"
            >
              导出
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

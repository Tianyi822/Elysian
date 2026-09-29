import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { X } from '../../components/icons'
import { FORM_CONTROL_HEIGHT_CLASS } from '../../components/formControl'
import { useWebsitesStore } from '../../stores/websitesStore'

/**
 * 项目设置弹窗：只改备注与到期时间，名称与根目录不动。
 * 提交失败保留弹窗，错误经通知条呈现。
 */

const INPUT_CLASS =
  `${FORM_CONTROL_HEIGHT_CLASS} w-full rounded-lg border border-line bg-surface-raised px-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle`

export function WebsitesSettingsDialog() {
  const gateway = useGateway()
  const settingsTarget = useWebsitesStore((s) => s.settingsTarget)
  const saving = useWebsitesStore((s) => s.saving)
  const closeSettings = useWebsitesStore((s) => s.closeSettings)
  const saveSettings = useWebsitesStore((s) => s.saveSettings)

  const [note, setNote] = useState(() => settingsTarget?.note ?? '')
  // date 输入只吃 YYYY-MM-DD，到期时间种子即此形态。
  const [expiryDate, setExpiryDate] = useState(() => settingsTarget?.expiryAt?.slice(0, 10) ?? '')

  if (!settingsTarget) return null

  const submit = () => {
    void saveSettings(gateway, settingsTarget.id, {
      note: note.trim() || null,
      expiryAt: expiryDate || null,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeSettings() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">设置项目 {settingsTarget.name}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <span className="text-sm font-medium text-fg">设置项目 {settingsTarget.name}</span>
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

          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
            <div>
              <label htmlFor="website-settings-expiry" className="mb-1 block text-xs font-medium text-fg-muted">
                到期时间
              </label>
              <input
                id="website-settings-expiry"
                type="date"
                value={expiryDate}
                onChange={(event) => setExpiryDate(event.target.value)}
                className={`${INPUT_CLASS} tabular-nums`}
              />
              <p className="mt-1 text-xs text-fg-subtle">清空日期表示长期有效。</p>
            </div>

            <div>
              <label htmlFor="website-settings-note" className="mb-1 block text-xs font-medium text-fg-muted">
                备注
              </label>
              <input
                id="website-settings-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="选填，说明这个项目的用途"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => closeSettings()}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={saving}
                className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
              >
                保存修改
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

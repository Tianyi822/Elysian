import * as Dialog from '@radix-ui/react-dialog'
import { X } from '../../components/icons'
import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useContainersStore } from '../../stores/containersStore'
import { parseImageReference } from './imageReference'

/**
 * 拉取镜像弹窗：一个引用输入框，格式与查重行内提示。
 * 提交后弹窗立即关闭，拉取中行与完成通知在镜像列表里呈现；
 * 拉取进行中重新打开时提交按钮呈「拉取中…」禁用态。
 */
export function ImagePullDialog({ onClose }: { onClose: () => void }) {
  const gateway = useGateway()
  const images = useContainersStore((s) => s.images)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const pullImage = useContainersStore((s) => s.pullImage)
  const [reference, setReference] = useState('')

  const parsed = parseImageReference(reference)
  const duplicate =
    parsed.ok && images.some((i) => i.name === parsed.reference.name && i.tag === parsed.reference.tag)
  const error = !parsed.ok
    ? parsed.error
    : duplicate
      ? `镜像已存在：${parsed.reference.name}:${parsed.reference.tag}`
      : undefined
  // 单字段表单：错误实时显示，无效恒禁用提交。
  const showError = reference.trim() !== '' && Boolean(error)

  const submit = () => {
    if (!parsed.ok || duplicate) return
    onClose()
    void pullImage(gateway, parsed.reference)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">拉取镜像</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                演示 · 待接入真实执行
              </span>
              <span className="text-sm font-medium text-fg">拉取镜像</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <X aria-hidden size={13} className="mr-1 inline align-[-2px]" />
              关闭
            </button>
          </div>

          <div className="px-4 py-3">
            <label htmlFor="pull-reference" className="mb-1 block text-xs font-medium text-fg-muted">
              镜像引用
            </label>
            <input
              id="pull-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="例如 redis:8-alpine，标签缺省为 latest"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={showError ? 'pull-reference-error' : undefined}
              className="w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 font-mono text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
            />
            {showError ? (
              <p className="mt-1 text-xs text-danger" id="pull-reference-error">
                {error}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-fg-subtle">拉取由演示数据模拟，不访问真实镜像仓库。</p>
          </div>

          <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
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
              disabled={Boolean(error) || Boolean(pullingImage)}
              className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pullingImage ? '拉取中…' : '拉取'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

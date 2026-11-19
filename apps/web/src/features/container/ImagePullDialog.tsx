import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../components/Button'
import { X } from '../../components/icons'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { ImagePullFields } from './ImagePullFields'
import { useImagePullForm } from './useImagePullForm'

/**
 * 拉取镜像弹窗：镜像源预设下拉（含自定义地址兜底与逐项测速）+ 镜像引用两个输入，
 * 格式与查重行内提示，有效引用实时预览完整拉取路径。提交后弹窗立即关闭，拉取中行与
 * 完成通知在镜像列表里呈现；Docker 运行时为真实拉取，演示模式只作记录。
 * 测速只由点击触发、结果不持久化：速度是时点事实，持久化就是过期的谎言。
 */
export function ImagePullDialog({ onClose }: { onClose: () => void }) {
  const docker = isDockerRuntime()
  const form = useImagePullForm(onClose)
  const { invalid, pullingImage, submit } = form

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
            <Button variant="ghost" size="icon"
              type="button"
              onClick={onClose}
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </Button>
          </div>

          <ImagePullFields form={form} docker={docker} />

          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-xs text-fg-subtle">
              {docker
                ? '从镜像仓库拉取，只支持公开镜像。'
                : '拉取由演示数据模拟，不访问真实镜像仓库。'}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline"
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </Button>
              <Button variant="primary"
                type="button"
                onClick={submit}
                disabled={invalid || Boolean(pullingImage)}
                className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pullingImage ? '拉取中…' : '拉取'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

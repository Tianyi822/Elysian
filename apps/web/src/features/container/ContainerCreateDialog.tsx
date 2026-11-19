import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../components/Button'
import { X } from '../../components/icons'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { ContainerCreateFields } from './ContainerCreateFields'
import { useContainerCreateForm } from './useContainerCreateForm'

/**
 * 创建容器弹窗（仿 Docker Desktop 的 Run a new container）：必填区只有镜像与名称，
 * 其余配置收进「可选设置」折叠区。提交不绑定 form 的回车提交（避开输入法组合回车），
 * 只走按钮点击。
 */
export function ContainerCreateDialog() {
  const form = useContainerCreateForm()
  const docker = isDockerRuntime()
  if (!form) return null

  const { creating, createError, closeCreate, disabled, submit, fields } = form

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCreate() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「关闭」「取消」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">创建容器</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {docker ? null : (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              )}
              <span className="text-sm font-medium text-fg">创建容器</span>
            </div>
            <Button variant="ghost" size="icon"
              type="button"
              onClick={closeCreate}
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </Button>
          </div>

          <ContainerCreateFields {...fields} />

          {createError ? <p role="alert" className="px-4 py-2 text-xs text-danger">{createError}</p> : null}
          <div className="flex flex-col items-stretch gap-3 border-t border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-fg-subtle">
              {docker ? '创建后立即启动。' : '创建后立即运行；所有数据仅存在于演示内存。'}
            </p>
            <div className="flex shrink-0 justify-end gap-2 whitespace-nowrap">
              <Button
                type="button"
                onClick={closeCreate}
                variant="outline"
                size="sm"
                className="h-9"
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={submit}
                disabled={disabled}
                isLoading={creating}
                loadingText="创建中…"
                size="sm"
                className="h-9"
              >
                创建并运行
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

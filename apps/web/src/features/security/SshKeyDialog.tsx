import * as Dialog from '@radix-ui/react-dialog'
import type { SshKeyMaterial } from '@elysian/contracts'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { CopyButton } from '../../components/CopyButton'
import { X } from '../../components/icons'
import { formatDateTime } from '../../components/format'

/**
 * 查看密钥弹窗：展示指纹、算法、生成时间与公钥全文，可复制。
 * Root 密钥与登录密钥共用这一个弹窗，标题与材料由调用方给定。
 * 私钥只在创建/生成后的一次性弹窗里出现（见 SshKeyRevealDialog），这里永远只有公钥。
 * 下载在浏览器本地完成，不发网络请求。
 */
export function SshKeyDialog({
  title,
  material,
  onClose,
}: {
  title: string
  material: SshKeyMaterial
  onClose: () => void
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(36rem,calc(100vh-3rem))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              {/* 真实运行时不加演示标注——密钥就是密钥；演示态保留提示。 */}
              {!isDockerRuntime() ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                  演示密钥 · 不对应任何真实主机
                </span>
              ) : null}
              <span className="text-sm font-medium text-fg">{title}</span>
            </div>
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

          <div className="overflow-y-auto px-4 py-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-fg-muted">算法</dt>
              <dd className="text-fg">{material.algorithm}</dd>
              <dt className="text-fg-muted">指纹</dt>
              <dd className="break-all font-mono text-fg">{material.fingerprint}</dd>
              <dt className="text-fg-muted">生成时间</dt>
              <dd className="tabular-nums text-fg">{formatDateTime(material.createdAt)}</dd>
            </dl>

            <p className="mt-4 mb-1.5 text-xs font-medium text-fg-muted">公钥内容</p>
            {/* 公钥区可聚焦：键盘用户因此也能滚动读完这段长文本。 */}
            <pre
              tabIndex={0}
              className="max-h-40 overflow-auto rounded-lg border border-control-line bg-surface-raised p-3 font-mono text-xs whitespace-pre break-all text-fg"
            >
              {material.publicKey}
            </pre>
            <p className="mt-2 text-xs text-fg-subtle">
              这行公钥保存在本机授权文件里；私钥只在创建/生成的那一次展示过，这里不再提供。
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            {!isDockerRuntime() ? (
              <p className="text-xs text-fg-subtle">密钥材料只存在于演示数据里。</p>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <CopyButton label="公钥" value={material.publicKey} tooltip="复制公钥全文" />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

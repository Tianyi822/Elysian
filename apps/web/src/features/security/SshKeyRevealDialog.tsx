import * as Dialog from '@radix-ui/react-dialog'
import type { SshKeyMaterial } from '@elysian/contracts'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { CopyButton } from '../../components/CopyButton'
import { X } from '../../components/icons'
import { formatDateTime } from '../../components/format'
import { buildKeyFilename, downloadPrivateKey } from './sshKeyIO'

/**
 * 一次性私钥弹窗：创建登录密钥或生成 Root 密钥成功后打开，材料直接来自那一次响应。
 * 私钥仅此一次可见——关闭即清空（store 的 closeRevealKey），此后任何入口都不再返回它；
 * 因此这里把「先保存再关闭」写成显眼的前提，并提供复制与本地下载（不发网络请求）。
 */
export function SshKeyRevealDialog({
  title,
  account,
  material,
  onClose,
}: {
  title: string
  /** 归属账号名：下载文件名以它开头（root-ssh-key-…/账号名-ssh-key-…）。 */
  account: string
  material: SshKeyMaterial
  onClose: () => void
}) {
  const filename = buildKeyFilename(account, new Date().toISOString())
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(38rem,calc(100vh-3rem))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                私钥仅此次可见
              </span>
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

            <p className="mt-4 mb-1.5 text-xs font-medium text-fg-muted">私钥内容</p>
            {/* 私钥区可聚焦：键盘用户因此也能滚动读完这段长文本。 */}
            <pre
              tabIndex={0}
              className="max-h-56 overflow-auto rounded-lg border border-line bg-surface-raised p-3 font-mono text-xs whitespace-pre text-fg"
            >
              {material.privateKey}
            </pre>
            <p className="mt-2 text-xs text-warning">
              关闭弹窗后私钥无法再次查看，也不会再下发：请先下载或复制保存到安全的位置。
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <p className="text-xs text-fg-subtle">
              {isDockerRuntime()
                ? '公钥已写入本机授权文件，这份私钥只在本次响应里。'
                : '密钥材料只存在于演示数据里。'}
            </p>
            <div className="flex items-center gap-2">
              <CopyButton label="私钥" value={material.privateKey ?? ''} tooltip="复制私钥全文" />
              <button
                type="button"
                onClick={() => downloadPrivateKey(filename, material)}
                className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle"
              >
                下载私钥
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

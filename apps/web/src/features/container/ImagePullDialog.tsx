import * as Dialog from '@radix-ui/react-dialog'
import { X } from '../../components/icons'
import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useContainersStore } from '../../stores/containersStore'
import {
  DEFAULT_IMAGE_REGISTRY,
  parseImageReference,
  registryHost,
  validateRegistryUrl,
} from './imageReference'

/**
 * 拉取镜像弹窗：拉取源 + 镜像引用两个输入，格式与查重行内提示，
 * 有效引用实时预览完整拉取路径。提交后弹窗立即关闭，拉取中行与
 * 完成通知在镜像列表里呈现；拉取源只被记录，不产生真实数据流。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'
const FIELD_LABEL_CLASS = 'mb-1 block text-xs font-medium text-fg-muted'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'

export function ImagePullDialog({ onClose }: { onClose: () => void }) {
  const gateway = useGateway()
  const images = useContainersStore((s) => s.images)
  const pullingImage = useContainersStore((s) => s.pullingImage)
  const pullImage = useContainersStore((s) => s.pullImage)

  const [registryAddress, setRegistryAddress] = useState('')
  const [reference, setReference] = useState('')

  // 留空即默认官方地址；非空才校验格式。
  const registry = registryAddress.trim() || DEFAULT_IMAGE_REGISTRY
  const registryError = registryAddress.trim() ? validateRegistryUrl(registryAddress) : undefined

  const parsed = parseImageReference(reference)
  const duplicate =
    parsed.ok && images.some((i) => i.name === parsed.reference.name && i.tag === parsed.reference.tag)
  const referenceError = !parsed.ok
    ? parsed.error
    : duplicate
      ? `镜像已存在：${parsed.reference.name}:${parsed.reference.tag}`
      : undefined
  // 单字段实时提示：引用输入为空时不出错也不预览。
  const showReferenceError = reference.trim() !== '' && Boolean(referenceError)

  const invalid = Boolean(registryError) || Boolean(referenceError)
  const preview =
    parsed.ok && !duplicate && !registryError
      ? `${registryHost(registry)}/${parsed.reference.name}:${parsed.reference.tag}`
      : undefined

  const submit = () => {
    if (invalid || !parsed.ok || duplicate) return
    onClose()
    void pullImage(gateway, { ...parsed.reference, registry })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(34rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">拉取镜像</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                演示 · 待接入真实执行
              </span>
              <span className="text-sm font-semibold text-fg">拉取镜像</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <label htmlFor="pull-registry" className={FIELD_LABEL_CLASS}>
              自定义镜像源地址
            </label>
            <input
              id="pull-registry"
              value={registryAddress}
              onChange={(event) => setRegistryAddress(event.target.value)}
              placeholder="留空使用官方地址 registry-1.docker.io"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={registryError ? 'pull-registry-error' : undefined}
              className={`${INPUT_CLASS} font-mono`}
            />
            {registryError ? (
              <p className={FIELD_ERROR_CLASS} id="pull-registry-error">
                {registryError}
              </p>
            ) : null}
            <p className="mt-1.5 text-xs text-fg-subtle">
              未填写时从官方 Docker Hub 地址拉取；地址仅作记录，不产生真实数据流。
            </p>

            <div className="mt-4">
              <label htmlFor="pull-reference" className={FIELD_LABEL_CLASS}>
                镜像引用
              </label>
              <input
                id="pull-reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="例如 redis:8-alpine，标签缺省为 latest"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={showReferenceError ? 'pull-reference-error' : undefined}
                className={`${INPUT_CLASS} font-mono`}
              />
              {showReferenceError ? (
                <p className={FIELD_ERROR_CLASS} id="pull-reference-error">
                  {referenceError}
                </p>
              ) : null}
            </div>

            {preview ? (
              <div className="mt-4 rounded-lg border border-line bg-surface-raised px-3 py-2">
                <p className="text-xs text-fg-subtle">将拉取</p>
                <p className="mt-0.5 break-all font-mono text-sm text-fg">{preview}</p>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
            <p className="text-xs text-fg-subtle">拉取由演示数据模拟，不访问真实镜像仓库。</p>
            <div className="flex shrink-0 gap-2">
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
                disabled={invalid || Boolean(pullingImage)}
                className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pullingImage ? '拉取中…' : '拉取'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

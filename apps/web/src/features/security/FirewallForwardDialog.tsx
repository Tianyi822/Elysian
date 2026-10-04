import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { FIREWALL_PROTOCOLS } from '@elysian/contracts'
import type { FirewallForwardRule, FirewallProtocol } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'
import { FIREWALL_INPUT_CLASS, SegmentedControl, parsePortInput } from './firewallFormParts'

/**
 * 添加/修改端口转发弹窗：外部端口（单值或冒号段）DNAT 到目标地址与端口。
 * 真实态写入 before.rules 的 *nat 标记段并打开内核 ip_forward。
 */

type Draft = {
  protocol: FirewallProtocol
  port: string
  targetHost: string
  targetPort: string
  note: string
}

export function FirewallForwardDialog() {
  const gateway = useGateway()
  const dialogForward = useFirewallStore((s) => s.dialogForward)
  const saving = useFirewallStore((s) => s.saving)
  const closeDialog = useFirewallStore((s) => s.closeDialog)
  const saveForward = useFirewallStore((s) => s.saveForward)

  const editing: FirewallForwardRule | undefined = dialogForward !== 'new' ? dialogForward : undefined
  const [draft, setDraft] = useState<Draft>(() =>
    editing
      ? {
          protocol: editing.protocol,
          port: editing.portTo !== null ? `${editing.port}:${editing.portTo}` : `${editing.port}`,
          targetHost: editing.targetHost,
          targetPort: `${editing.targetPort}`,
          note: editing.note ?? '',
        }
      : { protocol: 'tcp', port: '', targetHost: '', targetPort: '', note: '' },
  )
  const [errors, setErrors] = useState<{ port?: string; host?: string; targetPort?: string }>({})

  if (dialogForward === undefined) return null
  const isNew = dialogForward === 'new'

  const submit = () => {
    const parsed = parsePortInput(draft.port)
    if ('error' in parsed) {
      setErrors({ port: parsed.error })
      return
    }
    const host = draft.targetHost.trim()
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      setErrors({ host: '目标地址需为 IPv4（如 10.0.0.5）' })
      return
    }
    const targetPort = Number(draft.targetPort)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      setErrors({ targetPort: '目标端口需为 1-65535 的整数' })
      return
    }
    setErrors({})
    void saveForward(gateway, {
      protocol: draft.protocol,
      port: parsed.port,
      portTo: parsed.portTo,
      targetHost: host,
      targetPort,
      note: draft.note.trim() || null,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeDialog() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(44rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">{isNew ? '添加端口转发' : '修改端口转发'}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {!isDockerRuntime() ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              ) : null}
              <span className="text-sm font-medium text-fg">
                {isNew ? '添加端口转发' : `修改端口转发 ${editing?.port} → ${editing?.targetHost}:${editing?.targetPort}`}
              </span>
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

          <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
            <div>
              <p className="mb-1 text-xs font-medium text-fg-muted">协议</p>
              <SegmentedControl
                groupLabel="协议"
                options={FIREWALL_PROTOCOLS.map((protocol) => ({ value: protocol, label: protocol }))}
                value={draft.protocol}
                onChange={(protocol) => setDraft((current) => ({ ...current, protocol }))}
              />
            </div>

            <div>
              <label htmlFor="firewall-forward-port" className="mb-1 block text-xs font-medium text-fg-muted">
                外部端口 <span className="text-danger">*</span>
              </label>
              <input
                id="firewall-forward-port"
                value={draft.port}
                onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value }))}
                placeholder="8080 或 1000:2000"
                inputMode="numeric"
                className={FIREWALL_INPUT_CLASS}
              />
              {errors.port ? <p className="mt-1 text-xs text-danger">{errors.port}</p> : null}
            </div>

            <div className="grid grid-cols-[1fr_9rem] gap-3">
              <div>
                <label htmlFor="firewall-forward-host" className="mb-1 block text-xs font-medium text-fg-muted">
                  目标地址 <span className="text-danger">*</span>
                </label>
                <input
                  id="firewall-forward-host"
                  value={draft.targetHost}
                  onChange={(event) => setDraft((current) => ({ ...current, targetHost: event.target.value }))}
                  placeholder="10.0.0.5"
                  className={FIREWALL_INPUT_CLASS}
                />
                {errors.host ? <p className="mt-1 text-xs text-danger">{errors.host}</p> : null}
              </div>
              <div>
                <label htmlFor="firewall-forward-target-port" className="mb-1 block text-xs font-medium text-fg-muted">
                  目标端口 <span className="text-danger">*</span>
                </label>
                <input
                  id="firewall-forward-target-port"
                  value={draft.targetPort}
                  onChange={(event) => setDraft((current) => ({ ...current, targetPort: event.target.value }))}
                  placeholder="80"
                  inputMode="numeric"
                  className={FIREWALL_INPUT_CLASS}
                />
                {errors.targetPort ? <p className="mt-1 text-xs text-danger">{errors.targetPort}</p> : null}
              </div>
            </div>

            <div>
              <label htmlFor="firewall-forward-note" className="mb-1 block text-xs font-medium text-fg-muted">
                备注
              </label>
              <input
                id="firewall-forward-note"
                value={draft.note}
                onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
                placeholder="选填"
                className={FIREWALL_INPUT_CLASS}
              />
            </div>

            <p className="text-xs text-fg-subtle">
              入站连接按 DNAT 转发到目标地址；真实执行需开启内核转发（有转发规则时自动开启）。
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            {!isDockerRuntime() ? (
              <p className="text-xs text-fg-subtle">只改演示内存，不触碰真实防火墙。</p>
            ) : null}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => closeDialog()}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={saving}
                className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
              >
                {isNew ? '添加转发' : '保存修改'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

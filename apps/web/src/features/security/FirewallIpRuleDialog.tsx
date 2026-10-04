import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { FIREWALL_POLICIES, FIREWALL_POLICY_LABELS } from '@elysian/contracts'
import type { FirewallIpRule, FirewallPolicy } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'
import { FIREWALL_INPUT_CLASS, SegmentedControl } from './firewallFormParts'

/**
 * 添加/修改 IP 规则弹窗：策略用分段按钮，来源（IP 或网段）与备注用输入框。
 * 来源必填具体地址——「所有来源」的放行/拒绝由默认策略承担，不在此处提供。
 */

type Draft = {
  policy: FirewallPolicy
  source: string
  note: string
}

export function FirewallIpRuleDialog() {
  const gateway = useGateway()
  const dialogIpRule = useFirewallStore((s) => s.dialogIpRule)
  const saving = useFirewallStore((s) => s.saving)
  const closeDialog = useFirewallStore((s) => s.closeDialog)
  const saveIpRule = useFirewallStore((s) => s.saveIpRule)

  const editing: FirewallIpRule | undefined = dialogIpRule !== 'new' ? dialogIpRule : undefined
  const [draft, setDraft] = useState<Draft>(() =>
    editing
      ? { policy: editing.policy, source: editing.source, note: editing.note ?? '' }
      : { policy: 'deny', source: '', note: '' },
  )
  const [sourceError, setSourceError] = useState<string | undefined>(undefined)

  if (dialogIpRule === undefined) return null
  const isNew = dialogIpRule === 'new'

  const submit = () => {
    const source = draft.source.trim()
    if (!source) {
      setSourceError('来源必填：IP 或网段（如 203.0.113.9、10.0.0.0/8、fd00::/8）')
      return
    }
    setSourceError(undefined)
    void saveIpRule(gateway, {
      policy: draft.policy,
      source,
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
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
        >
          <Dialog.Title className="sr-only">{isNew ? '添加 IP 规则' : '修改 IP 规则'}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {!isDockerRuntime() ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              ) : null}
              <span className="text-sm font-medium text-fg">
                {isNew ? '添加 IP 规则' : `修改 IP 规则 ${editing?.source}`}
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
              <p className="mb-1 text-xs font-medium text-fg-muted">策略</p>
              <SegmentedControl
                groupLabel="策略"
                options={FIREWALL_POLICIES.map((policy) => ({ value: policy, label: FIREWALL_POLICY_LABELS[policy] }))}
                value={draft.policy}
                onChange={(policy) => setDraft((current) => ({ ...current, policy }))}
              />
            </div>

            <div>
              <label htmlFor="firewall-ip-source" className="mb-1 block text-xs font-medium text-fg-muted">
                来源 <span className="text-danger">*</span>
              </label>
              <input
                id="firewall-ip-source"
                value={draft.source}
                onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}
                placeholder="203.0.113.9 或 10.0.0.0/8"
                className={FIREWALL_INPUT_CLASS}
              />
              {sourceError ? <p className="mt-1 text-xs text-danger">{sourceError}</p> : null}
            </div>

            <div>
              <label htmlFor="firewall-ip-note" className="mb-1 block text-xs font-medium text-fg-muted">
                备注
              </label>
              <input
                id="firewall-ip-note"
                value={draft.note}
                onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
                placeholder="选填"
                className={FIREWALL_INPUT_CLASS}
              />
            </div>
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
                {isNew ? '添加规则' : '保存修改'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

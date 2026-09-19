import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import {
  FIREWALL_ADDRESS_FAMILIES,
  FIREWALL_POLICIES,
  FIREWALL_POLICY_LABELS,
  FIREWALL_PROTOCOLS,
} from '@elysian/contracts'
import type {
  FirewallAddressFamily,
  FirewallPolicy,
  FirewallProtocol,
} from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'

/**
 * 添加/修改端口规则弹窗：协议、地址族、策略用分段按钮，端口与来源、备注用输入框。
 * 提交不绑定 form 的回车提交（避开输入法组合回车），只走按钮点击；
 * 保存失败（如端口规则重复）保留弹窗，错误经通知条呈现。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'

type Draft = {
  protocol: FirewallProtocol
  port: string
  family: FirewallAddressFamily
  policy: FirewallPolicy
  source: string
  note: string
}

function SegmentedControl<T extends string>({
  groupLabel,
  options,
  value,
  onChange,
}: {
  groupLabel: string
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="inline-flex overflow-hidden rounded-lg border border-line"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors ${
            index > 0 ? 'border-l border-line' : ''
          } ${
            option.value === value
              ? 'bg-surface-raised font-medium text-fg'
              : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function FirewallRuleDialog() {
  const gateway = useGateway()
  const dialogRule = useFirewallStore((s) => s.dialogRule)
  const saving = useFirewallStore((s) => s.saving)
  const closeDialog = useFirewallStore((s) => s.closeDialog)
  const saveRule = useFirewallStore((s) => s.saveRule)

  const editing = dialogRule !== 'new' ? dialogRule : undefined
  const [draft, setDraft] = useState<Draft>(() =>
    editing
      ? {
          protocol: editing.protocol,
          port: `${editing.port}`,
          family: editing.family,
          policy: editing.policy,
          // 「所有IP」不是要编辑的内容：留空即代表全部来源。
          source: editing.source === '所有IP' ? '' : editing.source,
          note: editing.note ?? '',
        }
      : { protocol: 'tcp', port: '', family: 'ipv4', policy: 'allow', source: '', note: '' },
  )
  const [portError, setPortError] = useState<string | undefined>(undefined)

  if (dialogRule === undefined) return null
  const isNew = dialogRule === 'new'

  const submit = () => {
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError('端口需为 1-65535 的整数')
      return
    }
    setPortError(undefined)
    void saveRule(gateway, {
      protocol: draft.protocol,
      port,
      family: draft.family,
      policy: draft.policy,
      source: draft.source.trim() || '所有IP',
      note: draft.note.trim() || null,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeDialog() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「关闭」「取消」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">{isNew ? '添加端口规则' : '修改端口规则'}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              {/* 真实执行时不加任何标注——动作就是动作；演示态保留提示。 */}
              {!isDockerRuntime() ? (
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
              ) : null}
              <span className="text-sm font-medium text-fg">
                {isNew ? '添加端口规则' : `修改端口规则 ${editing?.protocol} ${editing?.port}`}
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
            <div className="flex flex-wrap gap-4">
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
                <p className="mb-1 text-xs font-medium text-fg-muted">地址族</p>
                <SegmentedControl
                  groupLabel="地址族"
                  options={FIREWALL_ADDRESS_FAMILIES.map((family) => ({ value: family, label: family }))}
                  value={draft.family}
                  onChange={(family) => setDraft((current) => ({ ...current, family }))}
                />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-fg-muted">策略</p>
                <SegmentedControl
                  groupLabel="策略"
                  options={FIREWALL_POLICIES.map((policy) => ({
                    value: policy,
                    label: FIREWALL_POLICY_LABELS[policy],
                  }))}
                  value={draft.policy}
                  onChange={(policy) => setDraft((current) => ({ ...current, policy }))}
                />
              </div>
            </div>

            <div>
              <label htmlFor="firewall-rule-port" className="mb-1 block text-xs font-medium text-fg-muted">
                端口 <span className="text-danger">*</span>
              </label>
              <input
                id="firewall-rule-port"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value }))}
                placeholder="如 2234"
                className={`${INPUT_CLASS} tabular-nums`}
              />
              {portError ? <p className="mt-1 text-xs text-danger">{portError}</p> : null}
            </div>

            <div>
              <label htmlFor="firewall-rule-source" className="mb-1 block text-xs font-medium text-fg-muted">
                来源
              </label>
              <input
                id="firewall-rule-source"
                value={draft.source}
                onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}
                placeholder="不填默认任意来源"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="firewall-rule-note" className="mb-1 block text-xs font-medium text-fg-muted">
                备注
              </label>
              <input
                id="firewall-rule-note"
                value={draft.note}
                onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
                placeholder="选填，说明这条规则的用途"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          {/* ml-auto 保证按钮组恒靠右：演示态左侧有说明文字、真实态没有，布局都不变。 */}
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
                className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
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

import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import {
  FIREWALL_ADDRESS_FAMILIES,
  FIREWALL_DIRECTIONS,
  FIREWALL_DIRECTION_LABELS,
  FIREWALL_POLICIES,
  FIREWALL_POLICY_LABELS,
  FIREWALL_PROTOCOLS,
} from '@elysian/contracts'
import type {
  FirewallAddressFamily,
  FirewallDirection,
  FirewallPolicy,
  FirewallProtocol,
} from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'
import { FIREWALL_INPUT_CLASS, SegmentedControl, parsePortInput } from './firewallFormParts'
import { firewallRuleNoteProblem } from './firewallRuleIO'

/**
 * 添加/修改端口规则弹窗：协议、地址族、策略、方向用分段按钮，端口（单值或冒号段）、来源、备注用输入框。
 * 保存失败（如端口规则重复）保留弹窗与行内原因，并记录消息。
 */

type Draft = {
  protocol: FirewallProtocol
  port: string
  family: FirewallAddressFamily
  policy: FirewallPolicy
  direction: FirewallDirection
  source: string
  note: string
}

export function FirewallRuleDialog() {
  const gateway = useGateway()
  const dialogRule = useFirewallStore((s) => s.dialogRule)
  const saving = useFirewallStore((s) => s.saving)
  const operationError = useFirewallStore((s) => s.operationError)
  const closeDialog = useFirewallStore((s) => s.closeDialog)
  const saveRule = useFirewallStore((s) => s.saveRule)

  const editing = dialogRule !== 'new' ? dialogRule : undefined
  const [draft, setDraft] = useState<Draft>(() =>
    editing
      ? {
          protocol: editing.protocol,
          port: editing.portTo !== null ? `${editing.port}:${editing.portTo}` : `${editing.port}`,
          family: editing.family,
          policy: editing.policy,
          direction: editing.direction,
          // 「所有IP」不是要编辑的内容：留空即代表全部来源。
          source: editing.source === '所有IP' ? '' : editing.source,
          note: editing.note ?? '',
        }
      : { protocol: 'tcp', port: '', family: 'ipv4', policy: 'allow', direction: 'inbound', source: '', note: '' },
  )
  const [portError, setPortError] = useState<string | undefined>(undefined)

  if (dialogRule === undefined) return null
  const isNew = dialogRule === 'new'
  // 备注错误随输入即时推导（判据与服务端 ufw 场景一致），提交前用它把保存拦下。
  const noteError = firewallRuleNoteProblem(draft.note)

  const submit = () => {
    const parsed = parsePortInput(draft.port)
    if ('error' in parsed) {
      setPortError(parsed.error)
      return
    }
    setPortError(undefined)
    // 备注禁区前置拦截：提示已在输入框下常显，这里只挡保存，不发请求。
    if (noteError) return
    void saveRule(gateway, {
      protocol: draft.protocol,
      port: parsed.port,
      portTo: parsed.portTo,
      family: draft.family,
      policy: draft.policy,
      direction: draft.direction,
      source: draft.source.trim() || '所有IP',
      note: draft.note.trim() || null,
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeDialog() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「关闭」「取消」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(44rem,calc(100vh-3rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl"
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
                  options={FIREWALL_ADDRESS_FAMILIES.map((family) => ({ value: family, label: family === 'ipv4' ? 'IPv4' : 'IPv6' }))}
                  value={draft.family}
                  onChange={(family) => setDraft((current) => ({ ...current, family }))}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
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
                <p className="mb-1 text-xs font-medium text-fg-muted">方向</p>
                <SegmentedControl
                  groupLabel="方向"
                  options={FIREWALL_DIRECTIONS.map((direction) => ({ value: direction, label: FIREWALL_DIRECTION_LABELS[direction] }))}
                  value={draft.direction}
                  onChange={(direction) => setDraft((current) => ({ ...current, direction }))}
                />
              </div>
            </div>

            <div>
              <label htmlFor="firewall-rule-port" className="mb-1 block text-xs font-medium text-fg-muted">
                端口 <span className="text-danger">*</span>
              </label>
              <input
                id="firewall-rule-port"
                value={draft.port}
                onChange={(event) => setDraft((current) => ({ ...current, port: event.target.value }))}
                placeholder="8080 或 1000:2000"
                inputMode="numeric"
                className={FIREWALL_INPUT_CLASS}
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
                className={FIREWALL_INPUT_CLASS}
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
                placeholder="选填"
                aria-invalid={noteError ? true : undefined}
                className={FIREWALL_INPUT_CLASS}
              />
              {noteError ? <p className="mt-1 text-xs text-danger">{noteError}</p> : null}
            </div>
          </div>

          {/* ml-auto 保证按钮组恒靠右：演示态左侧有说明文字、真实态没有，布局都不变。 */}
          {operationError ? <p role="alert" className="px-4 py-2 text-xs text-danger">{operationError}</p> : null}
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

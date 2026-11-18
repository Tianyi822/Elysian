import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import {
  FIREWALL_ADDRESS_FAMILIES,
  FIREWALL_DIRECTIONS,
  FIREWALL_DIRECTION_LABELS,
  FIREWALL_POLICIES,
  FIREWALL_POLICY_LABELS,
  FIREWALL_PROTOCOLS,
  PANEL_PORT,
  firewallRuleScanEnabled,
  firewallRuleScanProblem,
} from '@elysian/contracts'
import type {
  FirewallAddressFamily,
  FirewallDirection,
  FirewallPolicy,
  FirewallProtocol,
  FirewallScanConfig,
} from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { X } from '../../components/icons'
import { useFirewallStore } from '../../stores/firewallStore'
import { FIREWALL_INPUT_CLASS, SegmentedControl, parsePortInput, firewallRuleNoteProblem } from './firewallFormParts'
import { Button } from '../../components/Button'
import { ToggleSwitch } from '../../components/ToggleSwitch'
import { usePanelStore } from '../../stores/panelStore'
import { ScrollArea } from '../../components/ScrollArea'

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

type ScanSettings = Omit<FirewallScanConfig, 'ports'>
type ScanDraft = Record<keyof ScanSettings, string>
const SCAN_FIELDS = [
  { key: 'windowSeconds', label: '判定窗口', unit: '秒', min: 10, max: 3600 },
  { key: 'hitCount', label: '触发阈值', unit: '次', min: 3, max: 1000 },
  { key: 'banSeconds', label: '封禁时长', unit: '秒', min: 60, max: 86400 },
] as const

export function FirewallRuleDialog() {
  const gateway = useGateway()
  const dialogRule = useFirewallStore((s) => s.dialogRule)
  const saving = useFirewallStore((s) => s.saving)
  const operationError = useFirewallStore((s) => s.operationError)
  const closeDialog = useFirewallStore((s) => s.closeDialog)
  const saveRule = useFirewallStore((s) => s.saveRule)
  const scan = useFirewallStore(s => s.scanProtection)
  const scanStatus = useFirewallStore(s => s.scanStatus)
  const ports = usePanelStore(s => s.info?.ports)

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
  const [scanChoice, setScanChoice] = useState<boolean | undefined>(undefined)
  const [scanDraft, setScanDraft] = useState<Partial<ScanDraft>>({})
  const [validateScan, setValidateScan] = useState(false)
  // 未编辑的字段跟随真实配置；读取或写入失败时保留用户已填的草稿。
  const scanValues: ScanDraft = {
    windowSeconds: `${scan.config.windowSeconds}`,
    hitCount: `${scan.config.hitCount}`,
    banSeconds: `${scan.config.banSeconds}`,
    ...scanDraft,
  }
  const scanErrors: Partial<ScanDraft> = {}
  for (const { key, label, min, max, unit } of SCAN_FIELDS) {
    const value = Number(scanValues[key])
    if (!scanValues[key].trim()) scanErrors[key] = `请填写${label}`
    else if (!Number.isInteger(value) || value < min || value > max) scanErrors[key] = `${label}需为 ${min}–${max} ${unit}的整数`
  }
  const parsedPort = parsePortInput(draft.port)
  const scanRule = { protocol: draft.protocol, direction: draft.direction, ...('error' in parsedPort ? { port: 0 } : parsedPort) }
  const scanProblem = 'error' in parsedPort ? '填写有效端口后可设置防扫描' : firewallRuleScanProblem(scanRule, [ports?.frontendPort ?? PANEL_PORT, ports?.backendPort ?? PANEL_PORT + 1])
  const scanEnabled = !scanProblem && (scanChoice ?? firewallRuleScanEnabled(scanRule, scan))

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
    if (scanEnabled) {
      setValidateScan(true)
      if (scanStatus !== 'ready' || Object.keys(scanErrors).length) return
    }
    void saveRule(gateway, {
      protocol: draft.protocol,
      port: parsed.port,
      portTo: parsed.portTo,
      family: draft.family,
      policy: draft.policy,
      direction: draft.direction,
      source: draft.source.trim() || '所有IP',
      note: draft.note.trim() || null,
    }, !scanProblem && scanStatus === 'ready' ? scanEnabled : undefined, scanEnabled ? {
      windowSeconds: Number(scanValues.windowSeconds),
      hitCount: Number(scanValues.hitCount),
      banSeconds: Number(scanValues.banSeconds),
    } : undefined)
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !saving) closeDialog() }}>
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
              <Button variant="ghost" size="icon"
                type="button"
                aria-label="关闭弹窗"
                disabled={saving}
                className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
              >
                <X aria-hidden size={15} />
              </Button>
            </Dialog.Close>
          </div>

          <ScrollArea label="端口规则表单"><fieldset disabled={saving} className="flex min-w-0 flex-col gap-4 px-4 py-4">
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

            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-fg">防扫描</p>
                <p className="mt-1 text-xs text-fg-muted">{scanProblem || (scanStatus !== 'ready' ? '防扫描状态未就绪，请刷新后重试' : '仅保护此 TCP 入站端口，IPv4／IPv6 共用设置')}</p>
                {scanStatus !== 'ready' ? <Button type="button" variant="link" className="mt-1 text-xs underline" onClick={() => void useFirewallStore.getState().refreshScan(gateway)}>重新读取防扫描状态</Button> : null}
              </div>
              <ToggleSwitch label="防扫描" checked={scanEnabled} disabled={!!scanProblem || scanStatus !== 'ready' || saving} onCheckedChange={setScanChoice} />
            </div>

            {scanEnabled ? <fieldset className="min-w-0 rounded-lg border border-line bg-surface px-3 py-3" aria-describedby="firewall-scan-config-description">
              <legend className="px-1 text-xs font-medium text-fg">防扫描配置</legend>
              <p id="firewall-scan-config-description" className="mb-3 text-xs leading-5 text-fg-muted">以下配置由所有已开启防扫描的端口共用，修改后统一生效。</p>
              <div className="grid min-w-0 grid-cols-1 gap-3 min-[480px]:grid-cols-3">
                {SCAN_FIELDS.map(({ key, label, unit, min, max }) => {
                  const id = `firewall-scan-${key}`
                  const error = validateScan ? scanErrors[key] : undefined
                  return <div key={key} className="min-w-0">
                    <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">
                      {label}（{unit}） <span aria-hidden className="text-danger">*</span>
                    </label>
                    <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1} required
                      value={scanValues[key]} onChange={event => setScanDraft(current => ({ ...current, [key]: event.target.value }))}
                      aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
                      className={FIREWALL_INPUT_CLASS} />
                    <p id={`${id}-hint`} className="mt-1 text-xs text-fg-subtle">{min}–{max} {unit}</p>
                    {error ? <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">{error}</p> : null}
                  </div>
                })}
              </div>
            </fieldset> : null}

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
          </fieldset></ScrollArea>

          {/* ml-auto 保证按钮组恒靠右：演示态左侧有说明文字、真实态没有，布局都不变。 */}
          {operationError ? <p role="alert" className="px-4 py-2 text-xs text-danger">{operationError}</p> : null}
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            {!isDockerRuntime() ? (
              <p className="text-xs text-fg-subtle">只改演示内存，不触碰真实防火墙。</p>
            ) : null}
            <div className="ml-auto flex shrink-0 gap-2 whitespace-nowrap">
              <Button variant="outline"
                type="button"
                onClick={() => closeDialog()}
                disabled={saving}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </Button>
              <Button variant="outline"
                type="button"
                onClick={submit}
                disabled={saving || (scanChoice !== undefined && !scanProblem && scanStatus !== 'ready')}
                className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
              >
                {isNew ? '添加规则' : '保存修改'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

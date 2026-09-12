import type { EventStreamStatus } from '@elysian/contracts'
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { PageHeader } from '../../components/PageHeader'
import { Section } from '../../components/Section'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { useTheme } from '../../app/theme/ThemeProvider'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import type { Theme } from '../../app/theme/ThemeProvider'

const STREAM_STATUS_LABELS: Record<EventStreamStatus, string> = {
  connecting: '连接中',
  live: '已连接',
  degraded: '已降级为内存事件源',
}

const STREAM_STATUS_TONES: Record<EventStreamStatus, StatusTone> = {
  connecting: 'neutral',
  live: 'success',
  degraded: 'warning',
}

const NOT_CONNECTED = [
  '真实 Kubernetes、SSH、云厂商与数据库：没有任何真实凭证或地址',
  '真实模型调用：界面上的判断与结论都是演示数据',
  '用户认证与多租户：当前只有一个隐含的本地用户',
  '生产级权限系统：只保留前端状态与接口占位',
  '真实执行通道：所有动作都停在「待接入真实执行」',
]

const PENDING_CAPABILITIES = [
  'harness 运行时：事件接入、运行状态机、策略与审批流水线',
  '执行 Worker：本地、容器与集群三种执行后端',
  '持久化与审计回放：审计记录目前只存在内存里',
  '打包与部署形态：bundle 与 profile 尚未实现',
]

export function SettingsPage() {
  const gateway = useGateway()
  const { theme, setTheme } = useTheme()
  const streamStatus = useEventStreamStore((state) => state.status)
  const connectEventStream = useEventStreamStore((state) => state.connect)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resetNote, setResetNote] = useState<string | undefined>(undefined)
  const [resetError, setResetError] = useState<string | undefined>(undefined)
  const [resetting, setResetting] = useState(false)

  const handleReset = async () => {
    setResetting(true)
    setResetError(undefined)
    setResetNote(undefined)
    try {
      await gateway.reset()
      setConfirmOpen(false)
      setResetNote('演示数据已重置回种子状态。已打开的页面需要重新进入或刷新，才会显示重置后的数据。')
    } catch (error) {
      setResetError(error instanceof Error ? error.message : '重置演示数据失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <>
      <PageHeader
        title="系统设置"
        description="主题、事件源状态，以及本阶段的边界声明。"
      />

      <Section title="外观" description="深色是默认主题，浅色与深色共用同一套语义令牌。">
        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="mb-1 text-xs text-fg-subtle">主题</legend>
          {(
            [
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
            ] as ReadonlyArray<{ value: Theme; label: string }>
          ).map((option) => (
            <label key={option.value} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="theme"
                className="size-3 accent-accent"
                checked={theme === option.value}
                onChange={() => setTheme(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className="mt-2 text-xs text-fg-muted">
          与页头右上角的切换按钮是同一个设置，两处状态始终一致。
        </p>
      </Section>

      <Section
        title="事件源"
        description="实时刷新来自同源的 mock 事件流端点；端点不可用时自动降级到内存事件源。"
      >
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs text-fg-subtle">当前状态</span>
          <StatusTag
            label={STREAM_STATUS_LABELS[streamStatus]}
            tone={STREAM_STATUS_TONES[streamStatus]}
          />
        </p>
        <p className="mt-1.5 max-w-prose text-xs text-fg-muted">
          降级意味着界面上的增量来自进程内的内存事件源，而不是线上事件流。演示环境里两者内容一致，
          真实接入后降级应当在运维上被当作告警对待。
        </p>
        <button
          type="button"
          onClick={() => connectEventStream(gateway.events)}
          className="mt-2 rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
        >
          重新连接事件源
        </button>
      </Section>

      <Section
        title="演示数据"
        description="把内存中的演示数据重置回固定种子，便于反复演示。"
      >
        {resetNote ? (
          <p
            role="status"
            className="mb-2 rounded border border-success/40 bg-success/10 px-2 py-1 text-xs text-success"
          >
            {resetNote}
          </p>
        ) : null}

        <Dialog.Root
          open={confirmOpen}
          onOpenChange={(open) => {
            setConfirmOpen(open)
            // 关掉弹窗就不再留着上一次的失败提示，避免它悬在页面上。
            if (!open) setResetError(undefined)
          }}
        >
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="rounded border border-line bg-surface-raised px-2 py-1 text-xs text-fg"
            >
              重置演示数据
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded border border-line bg-surface p-3"
            >
              <Dialog.Title className="mb-1.5 text-sm font-semibold">
                确认重置演示数据？
              </Dialog.Title>
              <p className="mb-2 text-xs text-fg-muted">
                审批状态、技能启停等本地改动都会回到初始种子状态。这一步不会影响任何真实系统。
              </p>
              {resetError ? (
                <p
                  role="alert"
                  className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
                >
                  重置演示数据失败：{resetError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-1 text-xs text-fg-muted"
                  >
                    取消
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  disabled={resetting}
                  onClick={() => void handleReset()}
                  className="rounded border border-danger/50 px-2 py-1 text-xs text-danger disabled:opacity-50"
                >
                  确认重置
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </Section>

      <Section
        title="本阶段的边界"
        description="明确没有连接什么、以及哪些能力还没有实现，避免把演示效果当成生产能力。"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium text-fg-muted">未连接的真实系统</h3>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-muted">
              {NOT_CONNECTED.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-fg-muted">待实现的能力</h3>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-fg-muted">
              {PENDING_CAPABILITIES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
    </>
  )
}

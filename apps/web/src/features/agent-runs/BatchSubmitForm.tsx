import { useState } from 'react'
import type { RuntimeStep, RuntimeToolName } from '@elysian/contracts'
import { RUNTIME_TOOL_NAMES } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_DANGER, CTL_PRIMARY } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentRunsStore } from '../../stores/agentRunsStore'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

/*
 * 旧版 tool-batch 提交表单：受控步骤列表只允许四条白名单只读工具（与契约
 * RUNTIME_TOOL_NAMES 同源），无参数。requestId 用 useInFlightSubmit 的
 * withRequestId 档生成并复用——同键重复提交按幂等回读原 Run，不产生第二个
 * Run；内容变化时换新键。提交成功后跳到该 Run 的详情视图并靠 3 秒轮询推进；
 * 页面刷新不重放（requestId 只存在于本组件实例的内存里）。
 */

const TOOL_OPTIONS: readonly { value: RuntimeToolName; label: string }[] = RUNTIME_TOOL_NAMES.map((name) => ({ value: name, label: name }))

const MOCK_NOTE = isDockerRuntime() ? '' : '（演示数据）'

export function BatchSubmitForm({ onSubmitted }: { onSubmitted: (runId: string) => void }) {
  const gateway = useGateway()
  const submit = useAgentRunsStore((state) => state.submitBatch)
  const notify = useNotificationStore((state) => state.notify)
  const { submitting, withRequestId, newRequestId } = useInFlightSubmit()
  const [steps, setSteps] = useState<readonly RuntimeToolName[]>(['docker_containers_list'])
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  const changeStep = (index: number, tool: RuntimeToolName): void => {
    setSteps((current) => current.map((value, position) => (position === index ? tool : value)))
    newRequestId()
  }
  const addStep = (): void => {
    setSteps((current) => [...current, 'docker_containers_list'])
    newRequestId()
  }
  const removeStep = (index: number): void => {
    setSteps((current) => current.filter((_, position) => position !== index))
    newRequestId()
  }

  const onSubmit = (): void => {
    setErrorMessage(undefined)
    void withRequestId(async (requestId) => {
      try {
        const input = { requestId, kind: 'tool-batch' as const, steps: steps.map((tool) => ({ tool, args: {} as Record<string, never> })) satisfies readonly RuntimeStep[] }
        const run = await submit(gateway, input)
        notify({ tone: 'success', message: `批次任务已提交${run.status === 'queued' ? '，排队中' : ''}（${run.id}）${MOCK_NOTE}` })
        onSubmitted(run.id)
      } catch (error) {
        const message = error instanceof Error ? error.message : '批次任务提交失败'
        setErrorMessage(message)
        notify({ tone: 'danger', message })
      }
    })
  }

  return (
    <section aria-label="批次任务提交" className="panel-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">提交批次任务（旧版 tool-batch 通道）</h2>
        <p className="text-xs text-fg-subtle">仅四条只读工具、无参数；同一 requestId 幂等回读原 Run</p>
      </div>
      <ol className="mt-3 space-y-2">
        {steps.map((tool, index) => (
          <li key={index} className="flex items-center gap-2">
            <label className="sr-only" htmlFor={`batch-step-${index}`}>第 {index + 1} 步工具</label>
            <SelectDropdown
              id={`batch-step-${index}`}
              ariaLabel={`第 ${index + 1} 步工具`}
              className="min-w-0 flex-1 text-xs"
              mono
              value={tool}
              onSelect={(value) => changeStep(index, value)}
              disabled={submitting}
              items={TOOL_OPTIONS}
            />
            <button
              type="button"
              className={CTL_DANGER}
              onClick={() => removeStep(index)}
              disabled={submitting || steps.length <= 1}
              title={steps.length <= 1 ? '至少保留一个步骤' : `移除第 ${index + 1} 步`}
            >
              移除
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={CTL_PRIMARY} onClick={addStep} disabled={submitting || steps.length >= 16}>
          添加步骤
        </button>
        <button type="button" className={CTL_PRIMARY} onClick={onSubmit} disabled={submitting || steps.length === 0}>
          {submitting ? '提交中…' : '提交批次任务并查看'}
        </button>
        {errorMessage !== undefined ? (
          <p role="alert" className="w-full text-xs text-danger">{errorMessage}</p>
        ) : null}
      </div>
    </section>
  )
}

import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentWorkflowDefinition } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentHttpError } from '../../adapters/http/agent/agentShared'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_CHIP, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { precheckDefinitionText } from './workflowJsonPrecheck'
import { WorkflowFormEditor } from './WorkflowFormEditor'

/** 模板编辑器的起点骨架：字段与示例保持与服务端结构一致。 */
const CREATE_SKELETON = `{
  "languageVersion": "v1",
  "name": "新工作流模板",
  "enabled": true,
  "goal": "描述这个工作流要完成什么",
  "inputSchemaJson": "{\\"type\\":\\"object\\"}",
  "outputSchemaJson": "{\\"type\\":\\"object\\"}",
  "entry": "collect",
  "steps": [
    {
      "id": "collect",
      "kind": "agent",
      "instruction": "收集需要的信息",
      "input": { "literalJson": "{}" },
      "outputSchemaJson": "{\\"type\\":\\"object\\"}",
      "finish": { "literalJson": "{}" }
    }
  ]
}`

function serializeForEditor(definition: AgentWorkflowDefinition): string {
  return JSON.stringify(
    {
      ...(definition.languageVersion === undefined ? {} : { languageVersion: definition.languageVersion }),
      name: definition.name,
      enabled: definition.enabled,
      goal: definition.goal,
      inputSchemaJson: definition.inputSchemaJson,
      outputSchemaJson: definition.outputSchemaJson,
      entry: definition.entry,
      steps: definition.steps,
    },
    null,
    2,
  )
}

/**
 * 新建/更新模板的受控 JSON 编辑器：>1 MiB、重复键与未知字段在前端预检，
 * 服务端 409/400 中文错误照原样透传；更新体带 expectedRevision CAS（无 requestId，
 * 单飞锁）。模板内层的字符串字段（literalJson、*SchemaJson）原样透传，不重序列化。
 */
export function DefinitionEditorDialog({
  definition,
  onClose,
  onSaved,
}: {
  /** 更新模式传入现有模板；新建传 undefined。 */
  definition?: AgentWorkflowDefinition
  onClose(): void
  onSaved(definition: AgentWorkflowDefinition): void
}) {
  const gateway = useGateway()
  const createDefinition = useAgentWorkflowsStore((state) => state.createDefinition)
  const updateDefinition = useAgentWorkflowsStore((state) => state.updateDefinition)
  const loadDetail = useAgentWorkflowsStore((state) => state.loadDefinitionDetail)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [text, setText] = useState(() => (definition === undefined ? CREATE_SKELETON : serializeForEditor(definition)))
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    setText(definition === undefined ? CREATE_SKELETON : serializeForEditor(definition))
    setMode('form')
    setErrorMessage(undefined)
    setConflict(false)
  }, [definition])

  const submit = async () => {
    const precheck = precheckDefinitionText(text)
    if (!precheck.ok) {
      setErrorMessage(precheck.message)
      setConflict(false)
      return
    }
    await inFlightOnly(async () => {
      try {
        const saved =
          definition === undefined
            ? await createDefinition(gateway, precheck.value)
            : await updateDefinition(gateway, definition.id, { ...precheck.value, expectedRevision: definition.revision })
        onSaved(saved)
      } catch (error) {
        const message = error instanceof Error ? error.message : '保存模板失败'
        setErrorMessage(message)
        setConflict(error instanceof AgentHttpError && error.code === 'revision-conflict')
      }
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">
            {definition === undefined ? '新建工作流模板' : `更新模板「${definition.name}」（当前修订 ${definition.revision}）`}
          </Dialog.Title>
          <p className="mt-1 text-xs text-fg-muted">
            模板按不可变修订保存：更新会生成新修订。{definition === undefined ? '创建体不含 id/revision/createdAt。' : `更新体顶层平铺 expectedRevision: ${definition.revision}（CAS）。`}
            重复键、未知字段与超过 1 MiB 的内容会在提交前拦截，服务端校验仍是最终权威。
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-fg-muted">模板定义</span>
            <div role="group" aria-label="模板编辑模式" className="flex gap-1">
              <button type="button" aria-pressed={mode === 'form'} className={CTL_CHIP} onClick={() => setMode('form')}>表单</button>
              <button type="button" aria-pressed={mode === 'json'} className={CTL_CHIP} onClick={() => setMode('json')}>高级 JSON</button>
            </div>
          </div>
          <div className="mt-1 min-h-[18rem] flex-1 overflow-hidden">
            {mode === 'form' ? (
              <WorkflowFormEditor text={text} onChange={setText} />
            ) : (
              <textarea
                id="workflow-definition-editor"
                aria-label="模板 JSON"
                value={text}
                onChange={(event) => setText(event.target.value)}
                spellCheck={false}
                className="h-full min-h-[18rem] w-full resize-y rounded border border-line bg-surface p-3 font-mono text-xs text-fg"
              />
            )}
          </div>
          {errorMessage ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {errorMessage}
              {conflict ? '（模板修订已被他人更新，可关闭后重新打开最新修订）' : ''}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            {conflict && definition !== undefined ? (
              <button
                type="button"
                className={CTL_SECONDARY}
                onClick={() => {
                  setConflict(false)
                  setErrorMessage(undefined)
                  void loadDetail(gateway, definition.id).then(() => onClose())
                }}
              >
                回读最新修订
              </button>
            ) : null}
            <button type="button" className={CTL_SECONDARY} onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="button" className={CTL_PRIMARY} disabled={submitting} onClick={() => void submit()}>
              {submitting ? '保存中…' : definition === undefined ? '创建模板' : '保存新修订'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import { useState } from 'react'
import * as Checkbox from '@radix-ui/react-checkbox'
import { validAgentModelReasoningLevels } from '@elysian/contracts'
import { Check, ChevronDown, Plus, X } from '../../components/icons'
import { CTL_FIELD, CTL_SECONDARY } from '../../components/formControl'
import type { DraftModel } from './modelDraft'

const multimodalInputs = [['image', '图片'], ['video', '视频']] as const

function CapabilityChoice({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:border-control-line has-[[data-state=checked]]:border-control-line has-[[data-state=checked]]:bg-surface-raised has-[[data-state=checked]]:text-fg">
    <Checkbox.Root checked={checked} onCheckedChange={value => onChange(value === true)} aria-label={label} className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-control-line outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-on-accent">
      <Checkbox.Indicator><Check aria-hidden size={12} strokeWidth={3} /></Checkbox.Indicator>
    </Checkbox.Root>{label}
  </label>
}

/** 能力声明逐模型保存，不自动启用联网、多模态输入或切换运行推理模式。 */
export function ModelAdvancedFields({ row, onChange }: { row: DraftModel; onChange(values: Partial<DraftModel>): void }) {
  const [adding, setAdding] = useState(false)
  const [level, setLevel] = useState('')
  const [error, setError] = useState<string>()
  const addLevel = () => {
    const next = level.trim()
    if (!validAgentModelReasoningLevels([...row.reasoningLevels, next])) {
      setError('最多 16 项；名称以小写字母开头，可含数字、下划线或短横线，最长 32 位，且不能重复。')
      return
    }
    onChange({ reasoningLevels: [...row.reasoningLevels, next] })
    setLevel(''); setAdding(false); setError(undefined)
  }
  return <details open className="group/advanced sm:col-span-2">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded py-1 text-xs font-medium text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
      <ChevronDown aria-hidden size={14} className="-rotate-90 transition-transform group-open/advanced:rotate-0" />高级配置
    </summary>
    <div className="mt-3 flex flex-col gap-4">
      <fieldset><legend className="mb-2 text-xs text-fg-muted">多模态输入</legend><div className="flex flex-wrap gap-2">
        {multimodalInputs.map(([key, label]) => <CapabilityChoice key={key} label={label} checked={row[key]} onChange={value => onChange({ [key]: value })} />)}
      </div></fieldset>
      <div>
        <p className="mb-2 text-xs text-fg-muted">推理等级（从低到高）</p>
        <div className="flex flex-wrap items-center gap-2">
          {row.reasoningLevels.map(item => <span key={item} className="inline-flex h-8 items-center gap-1 rounded-md border border-control-line bg-surface-raised pl-2.5 pr-1 text-xs text-fg">
            {item}<button type="button" aria-label={`移除推理等级 ${item}`} onClick={() => onChange({ reasoningLevels: row.reasoningLevels.filter(value => value !== item) })} className="flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"><X aria-hidden size={12} /></button>
          </span>)}
          {!adding && <button type="button" aria-label="添加推理等级" disabled={row.reasoningLevels.length >= 16} onClick={() => setAdding(true)} className="flex size-8 items-center justify-center rounded-md border border-line text-fg-muted hover:border-control-line focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"><Plus aria-hidden size={14} /></button>}
        </div>
        {adding && <div className="mt-2 flex flex-wrap items-center gap-2">
          <input aria-label="新的推理等级" value={level} maxLength={32} autoFocus onChange={event => { setLevel(event.target.value); setError(undefined) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); addLevel() } }} placeholder="例如 low、high、max" className={`${CTL_FIELD} h-8 min-w-0 flex-1 text-xs`} />
          <button type="button" onClick={addLevel} className={CTL_SECONDARY}>添加等级</button>
          <button type="button" aria-label="取消添加推理等级" onClick={() => { setAdding(false); setLevel(''); setError(undefined) }} className="flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-raised"><X aria-hidden size={14} /></button>
        </div>}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </div>
  </details>
}

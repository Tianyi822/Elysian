import { Button } from '../../components/Button'
import { useClipboardCopy } from '../../components/CopyButton'
import { Check, Copy } from '../../components/icons'

export function CopyPathButton({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useClipboardCopy()
  return (
    <Button variant="ghost" size="icon"
      type="button"
      onClick={() => void copy(value, label)}
      title={`复制${label}`}
      aria-label={`复制${label}`}
      className="icon-button inline-flex size-6 shrink-0 items-center justify-center text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg"
    >
      {copied ? <Check aria-hidden size={13} className="text-success" /> : <Copy aria-hidden size={13} />}
    </Button>
  )
}

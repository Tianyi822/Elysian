import { File, FileArchive, FileJson, FileText, Image, Music2, Video, X } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import type { AgentChatAttachment } from '../../contracts/agentChat'

function fileIcon(attachment: AgentChatAttachment) {
  if (attachment.type.startsWith('image/')) return Image
  if (attachment.type.startsWith('video/')) return Video
  if (attachment.type.startsWith('audio/')) return Music2
  if (/\.(zip|gz|tar|rar|7z)$/i.test(attachment.name)) return FileArchive
  if (/\.(json|yaml|yml|toml|js|ts|tsx|py|go|sh|html|css)$/i.test(attachment.name)) return FileJson
  if (/\.(pdf|txt|md|log|docx?|xlsx?|csv|pptx?)$/i.test(attachment.name)) return FileText
  return File
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ChatAttachment({ attachment, onRemove }: { attachment: AgentChatAttachment; onRemove?: () => void }) {
  const Icon = fileIcon(attachment)
  // 三态：available && serverId 正常（新流程上传成功）；available && !serverId 为旧版存量，
  // 已上传字节但服务端无引用，不能随消息发送；!available 仅本地字节未核对，只影响预览。
  const state = !attachment.available ? 'missing' : attachment.serverId ? 'ready' : 'legacy'
  return <li className={`chat-attachment ${state === 'missing' ? 'border-warning/50' : state === 'legacy' ? 'border-warning/50' : ''}`}>
    {attachment.previewUrl && attachment.available
      ? <img src={attachment.previewUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
      : <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-raised text-fg-muted"><Icon size={19} aria-hidden /></span>}
    <span className="min-w-0 flex-1">
      <span className="block truncate text-xs font-medium" title={attachment.name}>{attachment.name}</span>
      <span className={`mt-1 block text-[11px] ${state === 'ready' || state === 'missing' ? (attachment.available ? 'text-fg-muted' : 'text-warning') : 'text-warning'}`}>
        {state === 'legacy' ? '未上传，不能随消息发送' : attachment.available ? fileSize(attachment.size) : '文件不可用，请重新添加'}
      </span>
    </span>
    {onRemove && <IconButton label={`移除附件 ${attachment.name}`} variant="ghost" onPress={onRemove} className="shrink-0"><X size={13} aria-hidden /></IconButton>}
  </li>
}

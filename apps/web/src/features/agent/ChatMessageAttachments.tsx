import { useEffect, useState } from 'react'
import type { AgentMessageAttachment } from '@elysian/contracts'
import { Image as ImageIcon } from '../../components/icons'
import type { AgentConversationAdapter } from '../../contracts/agentChat'

/** 历史消息用户气泡的服务端附件缩略图：按需取字节生成 blob URL，卸载或换图时 revoke。 */
export function ChatMessageAttachments({ attachments, fetchBlob }: {
  attachments: readonly AgentMessageAttachment[]
  fetchBlob: AgentConversationAdapter['attachmentBlob']
}) {
  const [urls, setUrls] = useState<readonly (string | undefined)[]>(() => attachments.map(() => undefined))
  useEffect(() => {
    let revoked = false
    const created: string[] = []
    void Promise.all(attachments.map(async attachment => {
      try {
        const blob = await fetchBlob(attachment.id)
        if (revoked || typeof URL?.createObjectURL !== 'function') return undefined
        const url = URL.createObjectURL(blob)
        created.push(url)
        return url
      } catch { return undefined }
    })).then(next => {
      if (revoked) return
      setUrls(next)
    })
    return () => {
      revoked = true
      for (const url of created) URL.revokeObjectURL(url)
    }
  }, [attachments, fetchBlob])
  return <ul aria-label="消息附件" className="mt-2 flex flex-wrap gap-2">
    {attachments.map((attachment, index) => {
      const url = urls[index]
      return <li key={attachment.id} className="text-[11px] text-fg-muted">
        {url
          ? <span className="block"><img src={url} alt={attachment.name} title={attachment.name} className="size-20 rounded-lg border border-border object-cover" /></span>
          : <span className="grid size-20 place-items-center rounded-lg border border-border bg-surface-raised" title={attachment.name}><ImageIcon size={20} aria-hidden /></span>}
      </li>
    })}
  </ul>
}

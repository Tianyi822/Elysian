import { AGENT_ATTACHMENT_LIMITS, type AgentMessage } from '@elysian/contracts'
import { agentComposerFileKind, appendAgentTextFiles, readAgentTextFiles } from '../adapters/local/agentTextFiles'
import { prepareAgentImage } from '../adapters/local/agentImagePreparation'
import { agentChatAllAttachments } from '../contracts/agentChat'
import type { AgentChatAdapter, AgentChatAttachment, AgentChatSession, AgentConversationAdapter } from '../contracts/agentChat'
import { messageOf } from '../utils/errorMessage'
import type { MessageTone } from './messageStore'

export type AgentChatAttachmentState = {
  restoringAttachments: boolean
  uploadingAttachments: boolean
  addAttachments(api: AgentConversationAdapter, files: readonly File[], supportsImage?: boolean): Promise<void>
  removeAttachment(id: string): void
}

type AttachmentDisplay = Pick<AgentChatAttachmentState, 'restoringAttachments' | 'uploadingAttachments'> & {
  session: AgentChatSession | null
  inputError: string | null
}

type AttachmentContext = {
  adapter: Pick<AgentChatAdapter, 'attach' | 'discard' | 'restore'>
  get: () => AttachmentDisplay & { sending: boolean; stopping: boolean; messages: readonly AgentMessage[]; ensureSession(): Promise<void> }
  set: (state: Partial<AttachmentDisplay>) => void
  current: () => AgentChatSession
  persist: (session: AgentChatSession) => boolean
  update: (patch: Partial<AgentChatSession>) => boolean
  notify: (message: string, tone?: MessageTone) => void
  reportInput: (message: string) => void
  captureLifetime: () => () => boolean
  startRestore: (session: AgentChatSession) => () => boolean
}

const attachmentTotalNotice = '本条消息附件合计超过 8 MiB，请分批发送。'
const failureMessage = (error: unknown) => messageOf(error, '会话请求失败')
const checkAttachmentTotal = (bytes: number) => {
  if (bytes > AGENT_ATTACHMENT_LIMITS.maxMessageBytes) throw new Error(attachmentTotalNotice)
}

export function createAgentChatAttachments({ adapter, get, set, current, persist, update, notify, reportInput, captureLifetime, startRestore }: AttachmentContext) {
  let attachmentUploadVersion = 0
  let attachmentPreparation: AbortController | undefined
  let attachmentPersistenceFailed = false
  const missingAttachmentSets = new Map<string, string>()

  const beginPreparation = () => {
    const controller = new AbortController()
    attachmentPreparation = controller
    return controller
  }
  const finishPreparation = (controller: AbortController) => {
    if (attachmentPreparation === controller) attachmentPreparation = undefined
  }
  const restore = async (session: AgentChatSession) => {
    const valid = startRestore(session)
    let attachments: AgentChatAttachment[]
    try { attachments = await adapter.restore(agentChatAllAttachments(session)) }
    catch {
      if (!valid()) return
      attachments = agentChatAllAttachments(session).map(attachment => ({ ...attachment, available: false, previewUrl: undefined }))
      notify('本地附件恢复失败，草稿已保留；无法预览的文件可移除后重新添加。', 'warning')
    }
    if (!valid()) return
    const restored = new Map(attachments.map(attachment => [attachment.id, attachment]))
    const match = (attachment: AgentChatAttachment) => restored.get(attachment.id) ?? attachment
    const current = get().session!
    set({
      session: { ...current, attachments: current.attachments.map(match), messages: current.messages.map(message => ({ ...message, attachments: message.attachments.map(match) })),
        ...(current.editing ? { editing: { ...current.editing, preparedAttachments: current.editing.preparedAttachments?.map(item => ({ ...item, attachment: match(item.attachment) })) } } : {}) },
      restoringAttachments: false,
    })
    const missing = attachments.filter(attachment => !attachment.available).map(attachment => attachment.id).sort().join(',')
    if (missing && missingAttachmentSets.get(session.id) !== missing) notify('部分附件已无法从浏览器恢复，请重新选择需要发送的文件。', 'info')
    missingAttachmentSets.set(session.id, missing)
  }
  const uploadAndStore = async (api: AgentConversationAdapter, files: readonly File[], valid: () => boolean, signal: AbortSignal) => {
    const uploaded = await api.uploadAttachments(files, signal)
    if (!valid()) return null
    if (uploaded.items.length !== files.length) throw new Error('图片上传回执不完整，请重新添加。')
    const result = await adapter.attach(files)
    if (!valid()) {
      await adapter.discard(result.attachments.map(attachment => attachment.id))
      return null
    }
    const attachments = result.attachments.map((attachment, index) => {
      const item = uploaded.items[index]!
      return { ...attachment, serverId: item.id, width: item.width, height: item.height, type: item.mimeType, size: item.bytes }
    })
    if (!result.persisted && !attachmentPersistenceFailed) notify('附件仅在当前页面可用，浏览器暂时无法保存文件；刷新后请重新选择。', 'info')
    attachmentPersistenceFailed = !result.persisted
    return attachments
  }
  const discardPrepared = (session: AgentChatSession) => {
    const ids = session.editing?.preparedAttachments?.map(item => item.attachment.id) ?? []
    if (ids.length) void adapter.discard(ids)
  }
  const prepareExistingAttachments = async (api: AgentConversationAdapter, owner: AgentChatSession, valid: () => boolean, signal: AbortSignal) => {
    const editing = owner.editing
    const original = editing ? get().messages.find(message => message.id === editing.messageId) : undefined
    const sources = editing
      ? (editing.attachments ?? []).map(ref => {
        const item = original?.attachments?.find(attachment => attachment.id === ref.id)
        const prepared = editing.preparedAttachments?.find(item => item.sourceId === ref.id)?.attachment
        return { sourceId: ref.id, name: item?.name, bytes: prepared?.size ?? item?.bytes, width: prepared?.width ?? item?.width, height: prepared?.height ?? item?.height, prepared: !!prepared }
      })
      : owner.attachments.map(item => ({ sourceId: item.serverId!, name: item.name, bytes: item.size, width: item.width, height: item.height, prepared: false }))
    const replacements: { sourceId: string; file: File }[] = []
    let total = 0
    for (const source of sources) {
      if (source.prepared || (source.bytes !== undefined && source.bytes <= AGENT_ATTACHMENT_LIMITS.maxFileBytes && Math.max(source.width ?? 0, source.height ?? 0) <= 6000)) {
        total += source.bytes ?? 0
        checkAttachmentTotal(total)
        continue
      }
      const blob = await api.attachmentBlob(source.sourceId, signal)
      if (!valid()) return
      const file = new File([blob], source.name ?? (blob.type === 'image/jpeg' ? '图片.jpg' : '图片.png'), { type: blob.type })
      const prepared = await prepareAgentImage(file, signal)
      total += prepared.size
      checkAttachmentTotal(total)
      if (prepared !== file) replacements.push({ sourceId: source.sourceId, file: prepared })
      if (!valid()) return
    }
    if (!replacements.length) return
    const additions = await uploadAndStore(api, replacements.map(item => item.file), valid, signal)
    if (!additions) return
    const bySource = new Map(replacements.map((item, index) => [item.sourceId, additions[index]!]))
    const session = current()
    const saved = editing
      ? update({ editing: { ...session.editing!, preparedAttachments: [...(session.editing?.preparedAttachments ?? []),
        ...replacements.map((item, index) => ({ sourceId: item.sourceId, attachment: additions[index]! }))] } })
      : update({ attachments: session.attachments.map(attachment => bySource.get(attachment.serverId!) ?? attachment) })
    if (!editing) await adapter.discard(session.attachments.filter(attachment => bySource.has(attachment.serverId!)).map(attachment => attachment.id))
    if (!valid()) return
    if (!saved) throw new Error('无法保存图片处理结果，请恢复浏览器存储后再发送。')
  }

  const actions: Pick<AgentChatAttachmentState, 'addAttachments' | 'removeAttachment'> = {
    async addAttachments(api, files, supportsImage) {
      if (!files.length || get().uploadingAttachments) return
      if (get().sending || get().stopping) { reportInput('消息正在发送或停止，请稍后再添加文件。'); return }
      const lifetime = captureLifetime()
      const ready = get().ensureSession()
      const sessionId = current().id
      const version = ++attachmentUploadVersion
      const valid = () => version === attachmentUploadVersion && lifetime() && get().session?.id === sessionId
      const controller = beginPreparation()
      let uploading = false
      set({ uploadingAttachments: true, inputError: null })
      try {
        await ready
        if (!valid()) return
        if (!api.available) { reportInput('当前为本地演示，请在已连接后端的面板中添加附件。'); return }
        // 编辑只改文本：编辑期间不允许往草稿添加附件，避免编辑重发静默捎带新图。
        if (current().editing) { reportInput('正在编辑消息，完成后才能添加附件。'); return }
        const existing = current().attachments
        // 整批压缩和总量校验成功后再上传，失败保留原草稿。
        const rejected = files.filter(file => agentComposerFileKind(file) === 'unsupported')
        if (rejected.length) { reportInput(`不支持这些文件：${rejected.map(file => file.name).join('、')}。图片仅支持 JPEG 与 PNG；文本文件将读入草稿，PDF、Office、音频和视频暂不支持。`); return }
        const images = files.filter(file => agentComposerFileKind(file) === 'image')
        const texts = files.filter(file => agentComposerFileKind(file) === 'text')
        if (images.length && supportsImage === false) { reportInput('当前模型不支持图片输入，请切换支持图片的模型后再添加。'); return }
        const imported = await readAgentTextFiles(texts, controller.signal)
        if (!valid()) return
        appendAgentTextFiles(current().draft, imported)
        const prepared: File[] = []
        let total = existing.reduce((sum, attachment) => sum + attachment.size, 0)
        for (const file of images) {
          const processed = await prepareAgentImage(file, controller.signal)
          if (!valid()) return
          total += processed.size
          checkAttachmentTotal(total)
          prepared.push(processed)
        }
        checkAttachmentTotal(current().attachments.reduce((sum, attachment) => sum + attachment.size, 0) + prepared.reduce((sum, file) => sum + file.size, 0))
        uploading = prepared.length > 0
        const additions = prepared.length ? await uploadAndStore(api, prepared, valid, controller.signal) : []
        if (!additions) return
        const session = current()
        if (session.attachments.reduce((sum, attachment) => sum + attachment.size, 0) + additions.reduce((sum, attachment) => sum + attachment.size, 0) > AGENT_ATTACHMENT_LIMITS.maxMessageBytes) {
          await adapter.discard(additions.map(attachment => attachment.id))
          throw new Error(attachmentTotalNotice)
        }
        let draft: string
        try { draft = appendAgentTextFiles(session.draft, imported) }
        catch (error) { await adapter.discard(additions.map(attachment => attachment.id)); throw error }
        persist({ ...session, draft, attachments: [...session.attachments, ...additions] })
        if (texts.length) reportInput(`已将 ${texts.length} 个文本文件读入草稿，可编辑后发送。`)
        if (images.length) reportInput(`已添加 ${images.length} 张图片${draft.trim() ? '。' : '，请输入问题或说明后发送。'}`)
      } catch (error) {
        if (valid()) { reportInput(failureMessage(error)); if (uploading) notify(failureMessage(error)) }
      } finally {
        finishPreparation(controller)
        if (version === attachmentUploadVersion) set({ uploadingAttachments: false })
      }
    },
    removeAttachment(attachmentId) {
      set({ inputError: null })
      if (get().sending) return
      const session = current()
      persist({ ...session, attachments: session.attachments.filter(attachment => attachment.id !== attachmentId) })
      void adapter.discard([attachmentId])
    },
  }
  return {
    actions,
    beginPreparation,
    finishPreparation,
    restore,
    discardPrepared,
    prepareExistingAttachments,
    invalidate() {
      attachmentPreparation?.abort()
      attachmentUploadVersion += 1
    },
    clearFeedback() {
      missingAttachmentSets.clear()
      attachmentPersistenceFailed = false
    },
  }
}

import { useState } from 'react'
import type { FormEvent } from 'react'
import type { DatabaseContainerEngine } from '@elysian/contracts'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '../../components/Button'
import { DialogSurface } from '../../components/DialogSurface'
import { CTL_PRIMARY, CTL_SECONDARY, DIALOG_FORM_FIELD_CLASS, DIALOG_FORM_LABEL_CLASS } from '../../components/formControl'
import { useGateway } from '../../adapters/GatewayProvider'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useMessageStore } from '../../stores/messageStore'
import { captureAuthGeneration } from '../../utils/authGeneration'
import { messageOf } from '../../utils/errorMessage'

/**
 * 接管自装容器：用户在密码框里填写容器内的管理员凭据，面板核验通过后登记。
 * 密码只发给面板、只存服务端登记，不进入对话、模型上下文或本会话记录。
 */
export function DatabaseAdoptDialog({ containerId, name, engine, onClose }: { containerId: string; name: string; engine: DatabaseContainerEngine; onClose(): void }) {
  const gateway = useGateway()
  // 各引擎官方镜像的管理员账号不同：MySQL／MariaDB 是 root，Redis 是 default。
  const defaultUsername = engine === 'Redis' ? 'default' : 'root'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const auth = captureAuthGeneration()
    setError('')
    setBusy(true)
    try {
      await gateway.databases.adopt(containerId, { username: username.trim() || defaultUsername, password })
      if (auth !== captureAuthGeneration()) return
      useMessageStore.getState().notify({ tone: 'success', message: `已接管容器 ${name}，Agent 现在可以复用它建库` })
      await useDatabaseStore.getState().refreshAfterMutation(gateway, 'container')
      if (auth === captureAuthGeneration()) onClose()
    } catch (failure) {
      if (auth === captureAuthGeneration()) setError(messageOf(failure, '接管失败'))
    } finally {
      if (auth === captureAuthGeneration()) setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next && !busy) onClose() }}>
      <DialogSurface aria-describedby={undefined}>
        <Dialog.Title className="text-sm font-semibold">接管数据库容器 {name}</Dialog.Title>
        <p className="mt-2 text-xs text-fg-muted">
          填写该容器里的管理员账号与密码。面板会用它登录一次完成核验，密码只保存在面板登记里，不进入对话与模型上下文。
        </p>
        <form className="mt-4 space-y-3" onSubmit={(event) => void submit(event)}>
          <label className={DIALOG_FORM_LABEL_CLASS}>
            管理员用户名
            <input
              className={DIALOG_FORM_FIELD_CLASS}
              value={username}
              disabled={busy}
              autoComplete="username"
              placeholder={defaultUsername}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className={DIALOG_FORM_LABEL_CLASS}>
            管理员密码
            <input
              className={DIALOG_FORM_FIELD_CLASS}
              type="password"
              value={password}
              disabled={busy}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Dialog.Close asChild>
              <Button variant="outline" type="button" disabled={busy} className={CTL_SECONDARY}>取消</Button>
            </Dialog.Close>
            <Button variant="primary" type="submit" disabled={busy || password === ''} className={CTL_PRIMARY}>
              {busy ? '正在核验…' : '核验并接管'}
            </Button>
          </div>
        </form>
      </DialogSurface>
    </Dialog.Root>
  )
}

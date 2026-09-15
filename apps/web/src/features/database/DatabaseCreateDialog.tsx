import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, X } from '../../components/icons'
import { useGateway } from '../../adapters/GatewayProvider'
import { useDatabaseStore } from '../../stores/databaseStore'
import {
  DATABASE_ACCESS_SCOPES,
  DATABASE_ACCESS_SCOPE_LABELS,
  DATABASE_CHARSET_OPTIONS,
  containersForEngine,
  emptyDraft,
  generateDemoPassword,
  hasDatabaseCreateErrors,
  toDatabaseCreateInput,
  validateDatabaseCreateDraft,
} from './databaseCreateForm'
import type { DatabaseAccessScope } from './databaseCreateForm'

/**
 * 添加数据库弹窗：字段为名称、字符集（仅 SQL 引擎）、用户名、密码（可随机生成）、
 * 访问权限与承载容器。承载候选只列运行中且镜像匹配当前引擎的容器；
 * 提交不绑定 form 的回车提交（避开输入法组合回车），只走按钮点击。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'

export function DatabaseCreateDialog() {
  const gateway = useGateway()
  const engine = useDatabaseStore((s) => s.engine)
  const open = useDatabaseStore((s) => s.createOpen)
  const creating = useDatabaseStore((s) => s.creating)
  const databases = useDatabaseStore((s) => s.databases)
  const containers = useDatabaseStore((s) => s.containers)
  const images = useDatabaseStore((s) => s.images)
  const closeCreate = useDatabaseStore((s) => s.closeCreate)
  const createDatabase = useDatabaseStore((s) => s.createDatabase)

  const [draft, setDraft] = useState(() => emptyDraft(engine))
  const [showErrors, setShowErrors] = useState(false)

  useEffect(() => {
    if (open) {
      setDraft(emptyDraft(engine))
      setShowErrors(false)
    }
    // 弹窗每次打开都按当时的引擎重置草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const candidates = containersForEngine(engine, containers, images)
  const errors = validateDatabaseCreateDraft(draft, databases, engine)
  // 首次提交前不禁用：点提交要能揭示行内错误；提交后仍有错或提交中才禁用。
  const disabled = creating || (showErrors && hasDatabaseCreateErrors(errors))

  const patch = (part: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...part }))

  const submit = () => {
    setShowErrors(true)
    if (hasDatabaseCreateErrors(errors)) return
    void createDatabase(gateway, toDatabaseCreateInput(draft, engine))
  }

  const fieldLabel = (id: string, text: string, required = false) => (
    <div className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
      <label htmlFor={id}>{text}</label>
      {required ? <span className="text-danger">*</span> : null}
    </div>
  )

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCreate() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          // 点外部一律不关：填好的配置不该因为一次误点丢掉。Esc 与「关闭」「取消」仍可退出。
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">添加{engine}数据库</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                演示 · 待接入真实执行
              </span>
              <span className="text-sm font-medium text-fg">添加{engine}数据库</span>
            </div>
            <button
              type="button"
              onClick={closeCreate}
              className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              <X aria-hidden size={13} className="mr-1 inline align-[-2px]" />
              关闭
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <div>
                {fieldLabel('db-create-name', '数据库名', true)}
                <input
                  id="db-create-name"
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="例如 orders_replica"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={showErrors && errors.name ? 'db-create-name-error' : undefined}
                  className={`${INPUT_CLASS} font-mono`}
                />
                {showErrors && errors.name ? (
                  <p className={FIELD_ERROR_CLASS} id="db-create-name-error">{errors.name}</p>
                ) : null}
              </div>
              {engine === 'MariaDB' || engine === 'MySQL' ? (
                <div>
                  {fieldLabel('db-create-charset', '字符集')}
                  <select
                    id="db-create-charset"
                    value={draft.charset}
                    onChange={(event) => patch({ charset: event.target.value })}
                    className={INPUT_CLASS}
                  >
                    {DATABASE_CHARSET_OPTIONS.map((charset) => (
                      <option key={charset} value={charset}>
                        {charset}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                {fieldLabel('db-create-username', '用户名', true)}
                <input
                  id="db-create-username"
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                  placeholder="数据库用户"
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={showErrors && errors.username ? 'db-create-username-error' : undefined}
                  className={INPUT_CLASS}
                />
                {showErrors && errors.username ? (
                  <p className={FIELD_ERROR_CLASS} id="db-create-username-error">{errors.username}</p>
                ) : null}
              </div>
              <div>
                {fieldLabel('db-create-password', '密码', true)}
                <div className="flex gap-2">
                  <input
                    id="db-create-password"
                    value={draft.password}
                    onChange={(event) => patch({ password: event.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={showErrors && errors.password ? 'db-create-password-error' : undefined}
                    className={`${INPUT_CLASS} font-mono`}
                  />
                  <button
                    type="button"
                    title="随机生成演示密码"
                    aria-label="随机生成演示密码"
                    onClick={() => patch({ password: generateDemoPassword() })}
                    className="inline-flex shrink-0 items-center justify-center rounded-lg border border-line px-2.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                  >
                    <RefreshCw aria-hidden size={14} />
                  </button>
                </div>
                {showErrors && errors.password ? (
                  <p className={FIELD_ERROR_CLASS} id="db-create-password-error">{errors.password}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-3">
              {fieldLabel('db-create-scope', '访问权限')}
              <select
                id="db-create-scope"
                value={draft.accessScope}
                onChange={(event) =>
                  patch({ accessScope: event.target.value as DatabaseAccessScope })
                }
                className={INPUT_CLASS}
              >
                {DATABASE_ACCESS_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {DATABASE_ACCESS_SCOPE_LABELS[scope]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-fg-subtle">
                演示取值：真实实现由服务端把它落到账号的来源主机限制上。
              </p>
            </div>

            <div className="mt-3">
              {fieldLabel('db-create-container', '添加到容器', true)}
              {candidates.length ? (
                <select
                  id="db-create-container"
                  value={draft.containerId}
                  onChange={(event) => patch({ containerId: event.target.value })}
                  aria-describedby={showErrors && errors.containerId ? 'db-create-container-error' : undefined}
                  className={INPUT_CLASS}
                >
                  <option value="">选择运行中的容器</option>
                  {candidates.map((container) => {
                    const image = images.find((item) => item.id === container.imageId)
                    return (
                      <option key={container.id} value={container.id}>
                        {container.name}（{image ? `${image.name}:${image.tag}` : '未知镜像'}）
                      </option>
                    )
                  })}
                </select>
              ) : (
                <p className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
                  没有正在运行的 {engine} 容器可承载新数据库；先到容器页启动一个。
                </p>
              )}
              {showErrors && errors.containerId ? (
                <p className={FIELD_ERROR_CLASS} id="db-create-container-error">{errors.containerId}</p>
              ) : null}
              <p className="mt-1.5 text-xs text-fg-subtle">
                只列出运行中、且镜像与 {engine} 匹配的容器：数据库由容器承载，不落在容器里的数据库不存在。
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
            <p className="text-xs text-fg-subtle">创建后立即出现在列表中；所有数据仅存在于演示内存。</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeCreate}
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

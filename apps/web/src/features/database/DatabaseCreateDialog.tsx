import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { Check, ChevronDown, File, Loader2, RefreshCw, Upload, X } from '../../components/icons'
import { useGateway } from '../../adapters/GatewayProvider'
import { useDatabaseStore } from '../../stores/databaseStore'
import {
  DATABASE_ACCESS_SCOPES,
  DATABASE_ACCESS_SCOPE_LABELS,
  DATABASE_CHARSET_OPTIONS,
  SQLITE_FILE_SUFFIX,
  bytesToMb,
  containersForEngine,
  databaseNameFromFile,
  emptyDraft,
  generateDemoPassword,
  hasDatabaseCreateErrors,
  sqliteFilePath,
  toDatabaseCreateInput,
  validateDatabaseCreateDraft,
} from './databaseCreateForm'
import type {
  DatabaseAccessScope,
  DatabaseCreateDraft,
  DatabaseCreateFormErrors,
  SqliteFileSource,
} from './databaseCreateForm'

/**
 * 添加数据库弹窗：字段为名称、字符集（仅 SQL 引擎）、用户名、密码（可随机生成）、
 * 访问权限与承载容器。承载候选只列运行中且镜像匹配当前引擎的容器；
 * 提交不绑定 form 的回车提交（避开输入法组合回车），只走按钮点击。
 */

const INPUT_CLASS =
  'w-full rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'
const FIELD_ERROR_CLASS = 'mt-1 text-xs text-danger'

/**
 * SQLite 的数据库文件来源：拖拽上传、选择本地文件、直接在本机新建。
 * 拖拽与「选择本地文件」对表单是同一件事（拿到一个既有文件），只是两个入口；
 * 文件只在浏览器本地读取名称与大小，不上传、不解析内容。
 */
function SqliteFileField({
  draft,
  errors,
  showErrors,
  onPickFile,
  onPatch,
}: {
  draft: DatabaseCreateDraft
  errors: DatabaseCreateFormErrors
  showErrors: boolean
  onPickFile(file: File): void
  onPatch(part: Partial<DatabaseCreateDraft>): void
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) onPickFile(file)
  }

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
        <span id="db-create-source-label">文件来源</span>
        <span className="text-danger">*</span>
      </div>
      <div
        role="group"
        aria-labelledby="db-create-source-label"
        className="inline-flex overflow-hidden rounded-lg border border-line"
      >
        {(['upload', 'create'] as const).map((source: SqliteFileSource, index) => (
          <button
            key={source}
            type="button"
            aria-pressed={draft.fileSource === source}
            onClick={() => onPatch({ fileSource: source })}
            className={`whitespace-nowrap px-3 py-1.5 text-xs transition-colors ${
              index > 0 ? 'border-l border-line' : ''
            } ${
              draft.fileSource === source
                ? 'bg-surface-raised font-medium text-fg'
                : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
            }`}
          >
            {source === 'upload' ? '拖拽或选择本地文件' : '直接在本机新建'}
          </button>
        ))}
      </div>

      {draft.fileSource === 'upload' ? (
        <>
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`mt-2 flex flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-colors ${
              dragging ? 'border-accent bg-accent/5' : 'border-line bg-surface'
            }`}
          >
            <Upload aria-hidden size={18} className="text-fg-subtle" />
            {draft.fileName ? (
              <>
                <p className="flex items-center gap-1.5 font-mono text-xs text-fg">
                  <File aria-hidden size={13} className="text-fg-subtle" />
                  {draft.fileName}
                </p>
                <p className="text-xs text-fg-subtle">
                  {draft.fileSizeMb === undefined ? '大小未知' : `${draft.fileSizeMb} MB`}
                </p>
              </>
            ) : (
              <p className="text-xs text-fg-muted">把 SQLite 数据库文件拖到这里</p>
            )}
            <label
              htmlFor="db-create-file"
              className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              选择本地文件
            </label>
            <input
              id="db-create-file"
              ref={inputRef}
              type="file"
              accept={`.db,${SQLITE_FILE_SUFFIX},application/vnd.sqlite3,application/x-sqlite3`}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onPickFile(file)
              }}
            />
            <p className="text-xs text-fg-subtle">
              文件只在本地读取名称与大小，不上传内容；接入真实执行后由服务端落盘。
            </p>
          </div>
          {showErrors && errors.file ? <p className={FIELD_ERROR_CLASS}>{errors.file}</p> : null}
        </>
      ) : (
        <>
          <div className="mt-2">
            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
              <label htmlFor="db-create-directory">落点目录</label>
              <span className="text-danger">*</span>
            </div>
            <input
              id="db-create-directory"
              value={draft.directory}
              onChange={(event) => onPatch({ directory: event.target.value })}
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT_CLASS} font-mono`}
            />
            {showErrors && errors.directory ? (
              <p className={FIELD_ERROR_CLASS}>{errors.directory}</p>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-fg-subtle">
            SQLite 是嵌入式单文件数据库：新建时得到一个空的 {SQLITE_FILE_SUFFIX} 文件，没有容器、也没有账号。
          </p>
        </>
      )}

      <p className="mt-2 rounded-lg bg-surface-raised px-3 py-2 font-mono text-xs text-fg-muted">
        {draft.name.trim() ? sqliteFilePath(draft) : `落点：${draft.directory}/${'{数据库名}'}${SQLITE_FILE_SUFFIX}`}
      </p>
    </div>
  )
}
/**
 * 自绘下拉字段：Radix Select 渲染全部界面（不呼出操作系统原生下拉），
 * 语义仍是 listbox，键盘方向键与首字母跳转由 Radix 接管。
 */
function FormSelect({
  id,
  label,
  value,
  placeholder,
  options,
  onChange,
  required = false,
  error,
}: {
  id: string
  label: string
  value: string
  placeholder: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange(value: string): void
  required?: boolean
  error?: string
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
        <label id={`${id}-label`}>{label}</label>
        {required ? <span className="text-danger">*</span> : null}
      </div>
      <Select.Root value={value || undefined} onValueChange={onChange}>
        <Select.Trigger
          aria-labelledby={`${id}-label`}
          className={`${INPUT_CLASS} flex items-center justify-between gap-2 data-[placeholder]:text-fg-subtle`}
        >
          <Select.Value placeholder={placeholder} />
          <Select.Icon>
            <ChevronDown aria-hidden size={14} className="shrink-0 text-fg-subtle" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-[60] max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-line bg-surface p-1 text-xs shadow-lg"
          >
            <Select.Viewport>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 outline-none text-fg-muted data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="ml-auto inline-flex w-3.5 text-fg">
                    <Check aria-hidden size={13} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {error ? <p className={FIELD_ERROR_CLASS}>{error}</p> : null}
    </div>
  )
}

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
              aria-label="关闭弹窗"
              className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
              <div>
                {fieldLabel('db-create-name', engine === 'SQLite' ? '数据库名（取自文件名）' : '数据库名', true)}
                <input
                  id="db-create-name"
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder={engine === 'SQLite' ? '例如 elysian-notes' : '例如 orders_replica'}
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
                <FormSelect
                  id="db-create-charset"
                  label="字符集"
                  value={draft.charset}
                  placeholder="选择字符集"
                  options={DATABASE_CHARSET_OPTIONS.map((charset) => ({ value: charset, label: charset }))}
                  onChange={(charset) => patch({ charset })}
                />
              ) : null}
            </div>

            {engine === 'SQLite' ? (
              <SqliteFileField
                draft={draft}
                errors={errors}
                showErrors={showErrors}
                onPatch={patch}
                onPickFile={(file) =>
                  patch({
                    fileName: file.name,
                    fileSizeMb: bytesToMb(file.size),
                    // 数据库名跟着文件名走；用户改过就不覆盖（仅在为空或等于上一个文件名时同步）。
                    ...(draft.name.trim() && draft.name !== databaseNameFromFile(draft.fileName)
                      ? {}
                      : { name: databaseNameFromFile(file.name) }),
                  })
                }
              />
            ) : (
              <>
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
              <FormSelect
                id="db-create-scope"
                label="访问权限"
                value={draft.accessScope}
                placeholder="选择访问权限"
                options={DATABASE_ACCESS_SCOPES.map((scope) => ({
                  value: scope,
                  label: DATABASE_ACCESS_SCOPE_LABELS[scope],
                }))}
                onChange={(accessScope) => patch({ accessScope: accessScope as DatabaseAccessScope })}
              />
              <p className="mt-1 text-xs text-fg-subtle">
                演示取值：真实实现由服务端把它落到账号的来源主机限制上。
              </p>
            </div>

            <div className="mt-3">
              <FormSelect
                id="db-create-container"
                label="添加到容器"
                value={draft.containerId}
                placeholder="选择运行中的容器"
                required
                error={showErrors ? errors.containerId : undefined}
                options={candidates.map((container) => {
                  const image = images.find((item) => item.id === container.imageId)
                  return {
                    value: container.id,
                    label: `${container.name}（${image ? `${image.name}:${image.tag}` : '未知镜像'}）`,
                  }
                })}
                onChange={(containerId) => patch({ containerId })}
              />
              {candidates.length ? (
                <p className="mt-1.5 text-xs text-fg-subtle">
                  只列出运行中、且镜像与 {engine} 匹配的容器：数据库由容器承载，不落在容器里的数据库不存在。
                </p>
              ) : (
                <p className="mt-1.5 rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
                  没有正在运行的 {engine} 容器可承载新数据库；先到容器页启动一个。
                </p>
              )}
            </div>
              </>
            )}
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

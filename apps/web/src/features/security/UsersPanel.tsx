import { useEffect, useId, useMemo } from 'react'
import type { HostUser } from '@elysian/contracts'
import { HOST_USER_LOGIN_METHOD_LABELS, HOST_USER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { Pencil, RefreshCw, Search, Trash2 } from '../../components/icons'
import { useUsersStore } from '../../stores/usersStore'
import { ACTION_CLASS } from './sshCardParts'
import { HostUserDialog } from './HostUserDialog'
import { HostUserRemoveDialog } from './HostUserRemoveDialog'
import { filterHostUsers } from './hostUserSearch'

/**
 * 用户管理面板：工具栏加主机账号表格，没有卡片标题——工具行第一眼就说明这一页是干什么的。
 * 权限与分组沿用 Linux 的模型——主组与用户名同名，管理员组用一个标记表达，不另造枚举分组。
 * root 不在这里，它的登录策略在 SSH 管理页签的 Root 设置里。
 */
export function UsersPanel() {
  const gateway = useGateway()
  const status = useUsersStore((s) => s.status)
  const errorMessage = useUsersStore((s) => s.errorMessage)
  const users = useUsersStore((s) => s.users)
  const search = useUsersStore((s) => s.search)
  const syncing = useUsersStore((s) => s.syncing)
  const dialogUser = useUsersStore((s) => s.dialogUser)
  const setSearch = useUsersStore((s) => s.setSearch)
  const openCreate = useUsersStore((s) => s.openCreate)
  const syncFromSystem = useUsersStore((s) => s.syncFromSystem)
  const load = useUsersStore((s) => s.load)
  const searchInputId = useId()
  const filtered = useMemo(() => filterHostUsers(search, users), [search, users])

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载主机账号…" />
  }

  if (status === 'error') {
    return (
      <ErrorState
        title="账号数据加载失败"
        description={errorMessage}
        onRetry={() => void load(gateway)}
      />
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <button type="button" onClick={() => openCreate()} className={ACTION_CLASS}>
          创建用户
        </button>
        <div className="relative ml-auto w-full sm:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <label htmlFor={searchInputId} className="sr-only">
            搜索用户名或备注
          </label>
          <input
            id={searchInputId}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索用户名或备注"
            className="h-[34px] w-full rounded-lg border border-line bg-surface-raised pl-8 pr-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle"
          />
        </div>
        <IconButton
          label={syncing ? '正在从系统同步账号' : '从系统同步账号'}
          variant="solid"
          onPress={() => void syncFromSystem(gateway)}
        >
          <RefreshCw aria-hidden size={14} className={syncing ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      {/* 表格坐在面板里：行悬停向上步进一级表面；首列钉住，窄屏下其余列横向滚动。 */}
      <div
        role="region"
        aria-label="主机账号表"
        className="overflow-x-auto rounded-xl border border-line bg-surface"
      >
        {/* 44rem 是六列都不挤的下限：低于它整表横向滚动，而不是把备注压成几个字。
            备注与权限组要放中文，给得宽；操作列定宽，只占两枚按钮的宽度。 */}
        <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-0 text-left text-sm">
          <colgroup>
            <col className="w-[16%]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
            <col className="w-[10%]" />
            <col className="w-[32%]" />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr>
              {['用户名', '权限组', '登录方式', '状态', '备注', '操作'].map((label, index) => (
                <th
                  key={label}
                  scope="col"
                  className={`border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted ${
                    index === 0 ? 'sticky left-0 z-20 border-r' : ''
                  }`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="border-b border-line px-3 py-8 text-center text-sm text-fg-muted">
                  {users.length === 0
                    ? '还没有主机账号，点左上角「创建用户」新建一个'
                    : '没有匹配的账号，换个关键词或清空搜索'}
                </td>
              </tr>
            ) : (
              filtered.map((user) => <UserRow key={user.id} user={user} />)
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs tabular-nums text-fg-muted">
        {search.trim() ? `匹配 ${filtered.length} 个 · 共 ${users.length} 个主机账号` : `共 ${users.length} 个主机账号`}
      </p>

      {dialogUser !== undefined ? <HostUserDialog /> : null}
      <HostUserRemoveDialog />
    </div>
  )
}

function UserRow({ user }: { user: HostUser }) {
  const openEdit = useUsersStore((s) => s.openEdit)
  const openRemove = useUsersStore((s) => s.openRemove)

  return (
    <tr className="group transition-colors hover:bg-surface-raised">
      {/* 用户名钉在左边：窄屏横向滚动时它始终在视线里。 */}
      <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-surface px-3 py-2.5 font-medium text-fg group-hover:bg-surface-raised">
        {user.name}
      </td>
      {/* 主组与用户名同名，管理员组另加一个标记——这就是 Linux 的分组形态，不另造枚举。 */}
      <td className="border-b border-line px-3 py-2.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate tabular-nums text-fg-muted">{user.name}</span>
          {user.isAdmin ? <StatusTag label="管理员" tone="warning" /> : null}
        </span>
      </td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">
        {HOST_USER_LOGIN_METHOD_LABELS[user.loginMethod]}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <StatusTag
          label={HOST_USER_STATUS_LABELS[user.status]}
          tone={user.status === 'active' ? 'success' : 'neutral'}
        />
      </td>
      <td className="border-b border-line px-3 py-2.5 text-fg-muted">
        {user.note ? (
          <span className="block truncate" title={user.note}>
            {user.note}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="border-b border-line px-3 py-2.5">
        <div className="flex items-center justify-start gap-1">
          <IconButton label={`修改 ${user.name}`} variant="ghost" onPress={() => openEdit(user)}>
            <Pencil aria-hidden size={14} />
          </IconButton>
          <IconButton
            label={`删除 ${user.name}`}
            variant="ghost"
            tone="danger-hover"
            onPress={() => openRemove(user)}
          >
            <Trash2 aria-hidden size={14} />
          </IconButton>
        </div>
      </td>
    </tr>
  )
}

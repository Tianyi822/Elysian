import { useEffect, useMemo, useState } from 'react'
import type { HostUser } from '@elysian/contracts'
import { HOST_USER_LOGIN_METHOD_LABELS, HOST_USER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { StaleDataBanner } from '../../components/states/StaleDataBanner'
import { DemoBadge } from '../../components/DemoBadge'
import { RefreshButton } from '../../components/RefreshState'
import { Pencil, Trash2 } from '../../components/icons'
import { DataTable } from '../../components/DataTable'
import { TableBatchActions } from '../../components/TableBatchActions'
import { TableCreateButton } from '../../components/TableCreateButton'
import { useUsersStore } from '../../stores/usersStore'
import { HostUserDialog } from './HostUserDialog'
import { HostUserRemoveDialog } from './HostUserRemoveDialog'
import { filterHostUsers } from './hostUserSearch'
import { Button } from '../../components/Button'

/**
 * 用户管理面板：工具栏加主机账号表格，没有卡片标题——工具行第一眼就说明这一页是干什么的。
 * 权限与分组沿用 Linux 的模型——主组与用户名同名，管理员组用一个标记表达，不另造枚举分组。
 * root 不在这里，它的登录策略在 SSH 管理页签的 Root 设置里。
 * 数据来自用户 adapter：Docker 运行时由 HTTP adapter 真实执行容器内 useradd/usermod/userdel，
 * 宿主机本地开发是内存演示（工具栏带「演示数据」标识）；动作完成提示按运行时如实描述。
 */
export function UsersPanel() {
  const gateway = useGateway()
  const status = useUsersStore((s) => s.status)
  const errorMessage = useUsersStore((s) => s.errorMessage)
  const operationError = useUsersStore((s) => s.operationError)
  const users = useUsersStore((s) => s.users)
  const search = useUsersStore((s) => s.search)
  const syncing = useUsersStore((s) => s.syncing)
  const dialogUser = useUsersStore((s) => s.dialogUser)
  const setSearch = useUsersStore((s) => s.setSearch)
  const openCreate = useUsersStore((s) => s.openCreate)
  const syncFromSystem = useUsersStore((s) => s.syncFromSystem)
  const load = useUsersStore((s) => s.load)
  const [selected, setSelected] = useState<(string | number)[]>([])
  const removeUser = useUsersStore(s => s.removeUser)
  const removingUserIds = useUsersStore(s => s.removingUserIds)
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
      {errorMessage ? <StaleDataBanner className="mb-3" error={errorMessage} onRetry={() => void load(gateway)} /> : null}
      {operationError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 p-3 text-xs text-danger"><p className="min-w-0 flex-1">{operationError}</p><Button variant="outline" type="button" className="rounded border border-line px-3 py-1.5 text-fg" onClick={() => void load(gateway)}>重新读取状态</Button></div> : null}
      {/* 用户动作只在容器内真实执行；宿主机本地开发明示演示状态。 */}
      {!isDockerRuntime() ? (
        <div className="mb-4 panel-surface px-4 py-3">
          <DemoBadge />
        </div>
      ) : null}
      <DataTable rows={filtered} ariaLabel="主机账号表" query={search} onQueryChange={setSearch}
        className="dt-toolbar-inline-actions"
        toolbar={<div role="group" aria-label="用户操作" className="flex shrink-0 items-center gap-2">
          <TableCreateButton label="创建用户" onPress={() => openCreate()} />
          <RefreshButton className="dt-toolbar-control-icon"
            onPress={() => void syncFromSystem(gateway)} busy={syncing}
            label={syncing ? '正在从系统同步账号' : '从系统同步账号'} />
        </div>}
        filterMode="external" searchPlaceholder="搜索用户名或备注" busy={syncing}
        getRowId={user => user.id} getRowLabel={user => user.name} selected={selected} onSelectionChange={setSelected}
        columns={[
          { key: 'name', header: '用户名', primary: true, accessor: user => user.name, width: '16%' },
          { key: 'group', header: '权限组', accessor: user => user.name, width: '18%', cell: user => <span className="inline-flex items-center gap-1.5"><span>{user.name}</span>{user.isAdmin ? <StatusTag label="管理员" tone="warning" /> : null}</span> },
          { key: 'login', header: '登录方式', accessor: user => HOST_USER_LOGIN_METHOD_LABELS[user.loginMethod], width: '16%' },
          { key: 'status', header: '状态', accessor: user => HOST_USER_STATUS_LABELS[user.status], width: '10%', cell: user => <StatusTag label={HOST_USER_STATUS_LABELS[user.status]} tone={user.status === 'active' ? 'success' : 'neutral'} /> },
          { key: 'note', header: '备注', accessor: user => user.note, width: '28%', cell: user => <span title={user.note || undefined}>{user.note || '—'}</span> },
          { key: 'actions', header: '操作', sortable: false, width: '12%', cell: user => <UserActions user={user} /> },
        ]}
        bulkActions={ids => <TableBatchActions selectedRows={users.filter(user => ids.includes(user.id))}
          getRowId={user => user.id} getRowLabel={user => user.name} disabled={syncing}
          onSucceeded={ids => setSelected(current => current.filter(id => !ids.includes(id)))}
          actions={[{ key: 'remove', label: '删除', danger: true,
            description: isDockerRuntime() ? '真实执行 userdel（不带 -r）：主目录与文件保留，主组移除，授权 SSH 密钥失效；以账号身份运行的任务需另行处理。最后一个管理员仍受系统保护。' : '从演示数据集移除账号及其主组，以它授权的 SSH 密钥失效；不会触碰真实系统账号。',
            eligible: user => removingUserIds.includes(user.id) ? '账号正在删除' : user.name === 'root' ? 'Root 账号受保护' : undefined,
            execute: rows => removeUser(gateway, rows[0]!.id),
          }]} />}
      />
      {dialogUser !== undefined ? <HostUserDialog /> : null}
      <HostUserRemoveDialog />
    </div>
  )
}

function UserActions({ user }: { user: HostUser }) {
  const openEdit = useUsersStore(s => s.openEdit)
  const openRemove = useUsersStore(s => s.openRemove)
  const removing = useUsersStore(s => s.removingUserIds.includes(user.id))
  return <div className="flex items-center gap-1">
    <IconButton label={`修改 ${user.name}`} variant="ghost" disabled={removing} onPress={() => openEdit(user)}><Pencil aria-hidden size={14} /></IconButton>
    <IconButton label={`删除 ${user.name}`} variant="ghost" tone="danger-hover" disabled={removing} onPress={() => openRemove(user)}><Trash2 aria-hidden size={14} /></IconButton>
  </div>
}

import { useMemo, useState } from 'react'
import type { SshLoginKey } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { DataTable } from '../../components/DataTable'
import { TableBatchActions } from '../../components/TableBatchActions'
import { TableCreateButton } from '../../components/TableCreateButton'
import { IconButton } from '../../components/IconButton'
import { formatDateTime } from '../../components/format'
import { KeyRound, Trash2 } from '../../components/icons'
import { useSshStore } from '../../stores/sshStore'
import { filterSshKeys } from './sshKeySearch'
import { SshRefreshButton, SshRefreshError } from './SshRefresh'

/** 搜索仍按原名称、账号与指纹判据；私钥不进入列表。 */
export function SshKeyCard({ active }: { active: boolean }) {
  const gateway = useGateway()
  const keys = useSshStore(s => s.keys)
  const keyAccounts = useSshStore(s => s.keyAccounts)
  const search = useSshStore(s => s.keySearch)
  const setKeySearch = useSshStore(s => s.setKeySearch)
  const openCreateKey = useSshStore(s => s.openCreateKey)
  const removeKey = useSshStore(s => s.removeKey)
  const removingKeyIds = useSshStore(s => s.removingKeyIds)
  const [selected, setSelected] = useState<(string | number)[]>([])
  const ownerNameOf = useMemo(() => {
    const names = new Map(keyAccounts.map(account => [account.id, account.name]))
    return (userId: string) => names.get(userId) ?? '账号已删除'
  }, [keyAccounts])
  const rows = useMemo(() => filterSshKeys(search, keys, ownerNameOf), [search, keys, ownerNameOf])
  return <section aria-label="SSH 密钥" className="min-w-0">
    <SshRefreshError section="keys" />
    <DataTable rows={rows} ariaLabel="SSH 密钥表" active={active} query={search} onQueryChange={setKeySearch}
      className="dt-toolbar-inline-actions"
      toolbar={<div role="group" aria-label="密钥操作" className="flex shrink-0 items-center gap-2">
        <TableCreateButton label="创建 SSH 密钥" onPress={() => openCreateKey()} />
        <SshRefreshButton section="keys" className="dt-toolbar-control-icon" />
      </div>}
      filterMode="external" searchLabel="搜索密钥" searchPlaceholder="搜索名称、账号或指纹" getRowId={key => key.id} getRowLabel={key => key.name}
      selected={selected} onSelectionChange={setSelected}
      columns={[
        { key: 'name', header: '名称', primary: true, accessor: key => key.name, width: '30%' },
        { key: 'owner', header: '归属账号', accessor: key => ownerNameOf(key.userId), width: '22%' },
        { key: 'createdAt', header: '创建时间', accessor: key => key.createdAt, cell: key => formatDateTime(key.createdAt), width: '30%' },
        { key: 'actions', header: '操作', sortable: false, width: '18%', cell: key => <KeyActions sshKey={key} /> },
      ]}
      bulkActions={ids => <TableBatchActions selectedRows={keys.filter(key => ids.includes(key.id))}
        getRowId={key => key.id} getRowLabel={key => key.name}
        onSucceeded={ids => setSelected(current => current.filter(id => !ids.includes(id)))}
        actions={[{ key: 'remove', label: '删除', danger: true,
          description: isDockerRuntime() ? '删除后本机授权文件中的公钥一并移除，客户端不能再用这些私钥免密登录。' : '从演示数据集移除所选密钥，不触碰真实授权文件。',
          eligible: key => removingKeyIds.includes(key.id) ? '密钥正在删除' : undefined,
          execute: rows => removeKey(gateway, rows[0]!.id),
        }]} />}
    />
  </section>
}

function KeyActions({ sshKey }: { sshKey: SshLoginKey }) {
  const openKeyView = useSshStore(s => s.openKeyView)
  const openRemoveKey = useSshStore(s => s.openRemoveKey)
  const removing = useSshStore(s => s.removingKeyIds.includes(sshKey.id))
  return <div className="flex items-center gap-1">
    <IconButton label={`查看密钥 ${sshKey.name}`} variant="ghost" onPress={() => openKeyView(`查看密钥 · ${sshKey.name}`, sshKey)}><KeyRound aria-hidden size={14} /></IconButton>
    <IconButton label={`删除 ${sshKey.name}`} variant="ghost" tone="danger-hover" disabled={removing} onPress={() => openRemoveKey(sshKey)}><Trash2 aria-hidden size={14} /></IconButton>
  </div>
}

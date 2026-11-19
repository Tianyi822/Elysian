import { useEffect, useState } from 'react'
import { SSH_LOGIN_RESULT_LABELS } from '@elysian/contracts'
import { ChipGroup } from '../../components/ChipGroup'
import { DataTable } from '../../components/DataTable'
import { formatLoginIp, formatLoginTime } from '../../components/format'
import { StatusTag } from '../../components/StatusTag'
import { useSshStore } from '../../stores/sshStore'
import { SshKeyCard } from './SshKeyCard'
import { SshRefreshButton, SshRefreshError } from './SshRefresh'

type SshDataView = 'keys' | 'records'
const SSH_DATA_VIEWS = [
  { value: 'keys', label: 'SSH 密钥' },
  { value: 'records', label: 'SSH 登录记录' },
] as const

/** 页签持续挂载以保留滑块动画；两表独立挂载，隐藏表停用选择与批量操作。 */
export function SshDataCard({ enabled }: { enabled: boolean }) {
  const [view, setView] = useState<SshDataView>(enabled ? 'keys' : 'records')
  const activeView = enabled ? view : 'records'
  useEffect(() => { if (!enabled) setView('records') }, [enabled])

  return <section aria-label="SSH 数据" className="min-w-0 panel-surface p-3 sm:p-4">
    <ChipGroup ariaLabel="SSH 数据视图" items={enabled ? SSH_DATA_VIEWS : SSH_DATA_VIEWS.filter(item => item.value === 'records')}
      value={activeView} onSelect={setView} className="max-w-full" />
    {enabled ? <div hidden={activeView !== 'keys'} className="mt-4">
      <SshKeyCard active={activeView === 'keys'} />
    </div> : null}
    <div hidden={activeView !== 'records'} className="mt-4">
      <SshLoginRecordsCard active={activeView === 'records'} />
    </div>
  </section>
}

/** SSH 登录记录卡：按时间倒序列出登录事实，只读，界面不产生也不修改它。 */
function SshLoginRecordsCard({ active }: { active: boolean }) {
  const logInfo = useSshStore(s => s.overview?.logInfo)
  const loginRecords = useSshStore(s => s.loginRecords)
  return <section aria-label="SSH 登录记录" className="min-w-0">
    <SshRefreshError section="records" />
    {logInfo?.status === 'unavailable' ? <p className="mb-3 text-xs text-fg-subtle">登录日志不可用，请检查系统日志服务与读取权限</p> : null}
    <DataTable rows={loginRecords} ariaLabel="SSH 登录记录表" active={active} getRowId={record => record.id}
      toolbar={<SshRefreshButton section="records" />}
      getRowLabel={record => `${formatLoginIp(record.ip)} ${formatLoginTime(record.at)}`}
      searchPlaceholder="搜索 SSH 登录记录"
      columns={[
        { key: 'ip', header: 'IP 地址', primary: true, accessor: record => record.ip, width: '28%', cell: record => <span title={formatLoginIp(record.ip) === record.ip ? undefined : record.ip}>{formatLoginIp(record.ip)}</span> },
        { key: 'at', header: '登录时间', accessor: record => record.at, width: '34%', cell: record => formatLoginTime(record.at) },
        { key: 'port', header: '端口', accessor: record => record.port, width: '12%' },
        { key: 'result', header: '状态', accessor: record => SSH_LOGIN_RESULT_LABELS[record.result], width: '14%', cell: record => <StatusTag label={SSH_LOGIN_RESULT_LABELS[record.result]} tone={record.result === 'succeeded' ? 'success' : 'danger'} /> },
        { key: 'user', header: '用户', accessor: record => record.user, width: '12%' },
      ]}
    />
  </section>
}

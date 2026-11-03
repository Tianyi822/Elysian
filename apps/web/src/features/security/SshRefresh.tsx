import { useGateway } from '../../adapters/GatewayProvider'
import { RefreshButton } from '../../components/RefreshState'
import { useSshStore, type SshRefreshSection } from '../../stores/sshStore'

const labels: Record<SshRefreshSection, string> = {
  service: '刷新 SSH 状态',
  root: '刷新 Root 设置',
  keys: '刷新 SSH 密钥',
  records: '刷新 SSH 登录记录',
}

export function SshRefreshButton({ section }: { section: SshRefreshSection }) {
  const gateway = useGateway()
  const busy = useSshStore(state => state.sectionRefreshing[section])
  const refresh = useSshStore(state => state.refreshSection)
  return <RefreshButton label={labels[section]} busy={busy} onPress={() => void refresh(gateway, section)} />
}

export function SshRefreshError({ section }: { section: SshRefreshSection }) {
  const error = useSshStore(state => state.sectionErrors[section])
  return error ? <p role="alert" className="text-xs text-danger">刷新失败：{error}。已保留上次读取结果，请重新刷新。</p> : null
}

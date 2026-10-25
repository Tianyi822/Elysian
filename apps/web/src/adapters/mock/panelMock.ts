import { DEFAULT_PANEL_PORTS } from '@elysian/contracts'
import type { PanelAdapter } from '../../contracts/adapters'

const unavailable = async (): Promise<never> => { throw new Error('仅支持 systemd 安装版，演示模式不能重启或更新面板') }
/** 更新日志要读真实上游仓库，演示模式没有可查的提交历史。 */
const noHistory = async (): Promise<never> => { throw new Error('仅支持 systemd 安装版，演示模式没有可查的更新日志') }
export const mockPanelAdapter: PanelAdapter = {
  retryCLIRegistration: async () => { throw new Error('本地演示不执行 CLI 注册') },
  info: async () => ({ ports: { ...DEFAULT_PANEL_PORTS }, commit: '演示版本', buildTime: '', repository: 'Tianyi822/Elysian', available: false, reason: '仅支持 systemd 安装版，当前为演示模式', activeTask: null, lastTask: null }),
  checkUpdate: unavailable, commits: noHistory, ports: unavailable, restart: unavailable, update: unavailable, task: unavailable,
  ready: async () => false,
  taskByRequest: async () => null,
}

import { DEFAULT_PANEL_PORTS } from '@elysian/contracts'
import type { PanelAdapter } from '../../contracts/adapters'

const unavailable = async (): Promise<never> => { throw new Error('仅支持 systemd 安装版，演示模式不能重启或更新面板') }
export const mockPanelAdapter: PanelAdapter = {
  info: async () => ({ ports: { ...DEFAULT_PANEL_PORTS }, commit: '演示版本', buildTime: '', repository: 'Tianyi822/Elysian', available: false, reason: '仅支持 systemd 安装版，当前为演示模式', activeTask: null, lastTask: null }),
  checkUpdate: unavailable, ports: unavailable, restart: unavailable, update: unavailable, task: unavailable,
  ready: async () => false,
}

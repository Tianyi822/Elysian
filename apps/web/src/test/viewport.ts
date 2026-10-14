import { vi } from 'vitest'
import { NARROW_VIEWPORT_QUERY } from '../app/layout/narrowViewport'

/**
 * 把视口打桩成窄屏（<768px）：顶栏页签与仪表盘时间范围此时只显下拉形态。
 * jsdom 未实现 matchMedia（取到 undefined），默认口径是宽屏，因此只有窄屏形态需要打桩。
 * 只回答窄屏那一条查询，其余（如跟随系统主题的偏好查询）一律答 false，与 jsdom 原口径一致。
 * 用 vi.unstubAllGlobals() 收回，挂在用例文件或所在用例的收尾里。
 */
export function stubNarrowViewport(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === NARROW_VIEWPORT_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'
import { UI_PREFERENCES_KEY } from '../app/theme/themePreferences'
import { useContainersStore } from '../stores/containersStore'
import { useDatabaseStore } from '../stores/databaseStore'
import { useLogsStore } from '../stores/logsStore'
import { useNotificationStore } from '../stores/notificationStore'
import { useSecurityStore } from '../stores/securityStore'
import { useSettingsTabStore } from '../stores/settingsTabStore'

/*
 * Radix 的浮层组件依赖几个 jsdom 未实现的浏览器 API，缺了会在打开浮层时报错。
 * 只补最小的空实现，不做行为模拟。
 */

// Testing Library 的 findBy/waitFor 默认只等 1s：共享宿主机高负载时，mock 即时返回
// 的首屏渲染也可能超预算被误判为「找不到元素」。放宽到 5s 只影响等待上限，不影响断言。
configure({ asyncUtilTimeout: 5_000 })

if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverStub,
  })
}

if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    writable: true,
    value: () => {},
  })
}

if (!('hasPointerCapture' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'hasPointerCapture', {
    writable: true,
    value: () => false,
  })
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    writable: true,
    value: () => {},
  })
  Object.defineProperty(Element.prototype, 'releasePointerCapture', {
    writable: true,
    value: () => {},
  })
}

afterEach(() => {
  cleanup()
  // 通知是全局单例状态：不清空的话，上一条用例留下的提示会出现在下一条用例的界面里。
  useNotificationStore.getState().clear()
  // 界面偏好（主题、导航顺序、不再提示）与页签的会话内单例状态：用例之间都复位到默认，避免选中态串到下一条。
  localStorage.removeItem(UI_PREFERENCES_KEY)
  useSecurityStore.setState({ tab: 'firewall' })
  useLogsStore.setState({ tab: 'runtime' })
  useDatabaseStore.setState({ engine: 'MariaDB' })
  useContainersStore.setState({ view: 'grid' })
  useSettingsTabStore.setState({ tab: 'maintenance' })
})

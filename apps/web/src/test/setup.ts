import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { useNotificationStore } from '../stores/notificationStore'

/*
 * Radix 的浮层组件依赖几个 jsdom 未实现的浏览器 API，缺了会在打开浮层时报错。
 * 只补最小的空实现，不做行为模拟。
 */

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
})

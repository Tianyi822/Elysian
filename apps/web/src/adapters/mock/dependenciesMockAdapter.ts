import type { DependencyProbeReport } from '@elysian/contracts'
import type { DependenciesAdapter } from '../../contracts/adapters'

/** 演示模式恒报双就绪：宿主依赖状态只属于 Docker 运行时的真实场景，本地开发不展示降级。 */
const DEMO_DEPENDENCY_REPORT: DependencyProbeReport = {
  docker: { state: 'ok', detail: null },
  caddy: { state: 'ok', detail: null },
}

/**
 * 依赖检测 mock 实现：恒双 ok、不可变（演示模式，与 AGENTS.md 替换表摘要一致）。
 * 要复现 missing / error 等模拟态，测试在 gateway 字面量手写 dependencies 片注入
 * 可控 probe（WebsitesPage.test.tsx 的既有做法，与 sshPanel.ts 的委托替身同款接缝）；
 * 真实场景由 http 实现接 /api/platform/dependencies。
 */
export class MockDependenciesAdapter implements DependenciesAdapter {
  async probe(): Promise<DependencyProbeReport> {
    return DEMO_DEPENDENCY_REPORT
  }
}

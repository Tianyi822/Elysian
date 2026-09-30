import type { WebsiteRuntimeCatalog, WebsiteRuntimeCatalogReport } from '@elysian/contracts'

/** 仅供单元测试注入，真实服务没有固定版本目录。 */
export function runtimeReport(): WebsiteRuntimeCatalogReport {
  const catalog: WebsiteRuntimeCatalog = {
    java: [{ version: '17.0.1+12', image: 'eclipse-temurin:17.0.1_12-jre', maintenance: 'legacy', checkedAt: '2026-09-30' }],
    node: [{ version: '24.21.0', image: 'node:24.21.0', maintenance: 'maintained', checkedAt: '2026-09-30' }],
    go: [{ version: '1.16.7', image: 'golang:1.16.7', maintenance: 'legacy', checkedAt: '2026-09-30' }],
    python: [{ version: '3.9.7', image: 'python:3.9.7-slim', maintenance: 'legacy', checkedAt: '2026-09-30' }],
  }
  return { catalog, fetchedAt: '2026-09-30T00:00:00.000Z', stale: false, detail: null }
}

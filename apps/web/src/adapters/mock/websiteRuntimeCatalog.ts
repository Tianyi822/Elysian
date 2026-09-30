import type { WebsiteRuntimeCatalogReport } from '@elysian/contracts'

/** 仅用于离线演示与测试；Docker 运行时的版本目录由服务端自动查询。 */
const checkedAt = '2026-09-30'
export const MOCK_WEBSITE_RUNTIME_REPORT: WebsiteRuntimeCatalogReport = {
  fetchedAt: '2026-09-30T00:00:00.000Z', stale: false, detail: null,
  catalog: {
    java: [
      { version: '25.0.4.1+1', image: 'eclipse-temurin:25.0.4.1_1-jre', maintenance: 'maintained', checkedAt },
      { version: '17.0.20.1+1', image: 'eclipse-temurin:17.0.20.1_1-jre', maintenance: 'maintained', checkedAt },
      { version: '17.0.1+12', image: 'eclipse-temurin:17.0.1_12-jre', maintenance: 'legacy', checkedAt },
      { version: '16.0.2+7', image: 'eclipse-temurin:16.0.2_7-jdk', maintenance: 'legacy', checkedAt },
    ],
    node: [
      { version: '26.10.0', image: 'node:26.10.0', maintenance: 'maintained', checkedAt },
      { version: '24.21.0', image: 'node:24.21.0', maintenance: 'maintained', checkedAt },
      { version: '14.17.6', image: 'node:14.17.6', maintenance: 'legacy', checkedAt },
      { version: '14.17.5', image: 'node:14.17.5', maintenance: 'legacy', checkedAt },
    ],
    go: [
      { version: '1.27.1', image: 'golang:1.27.1', maintenance: 'maintained', checkedAt },
      { version: '1.16.7', image: 'golang:1.16.7', maintenance: 'legacy', checkedAt },
    ],
    python: [
      { version: '3.14.7', image: 'python:3.14.7-slim', maintenance: 'maintained', checkedAt },
      { version: '3.9.7', image: 'python:3.9.7-slim', maintenance: 'legacy', checkedAt },
    ],
  },
}

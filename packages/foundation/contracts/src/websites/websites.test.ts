import { describe, expect, it } from 'vitest'
import * as contracts from '../index.ts'
import {
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_CATEGORY_LABELS,
  WEBSITE_PROXY_STATES,
  WEBSITE_PROXY_STATE_LABELS,
  WEBSITE_ROOT_BASE,
  WEBSITE_PROJECT_NAME_MAX_LENGTH,
  isValidWebsiteDomain,
  isValidWebsiteProjectName,
  websiteDefaultDeployCommand,
  websiteProjectRootDir,
  websiteRuntimeImageRef,
  parseWebsiteRuntimeCatalogReport,
  isWebsiteRuntimeReleaseVersion,
  type WebsiteRuntimeCatalogReport,
} from '../index.ts'

describe('isValidWebsiteProjectName 收紧为路径段判据', () => {
  it('保留原有口径：去空白后 1–64 字符', () => {
    expect(WEBSITE_PROJECT_NAME_MAX_LENGTH).toBe(64)
    expect(isValidWebsiteProjectName('订单中心-api')).toBe(true)
    expect(isValidWebsiteProjectName('  blog  ')).toBe(true)
    expect(isValidWebsiteProjectName('   ')).toBe(false)
    expect(isValidWebsiteProjectName('x'.repeat(64))).toBe(true)
    expect(isValidWebsiteProjectName('x'.repeat(65))).toBe(false)
  })

  it('拒绝路径分隔符、bind 分隔符与控制字符', () => {
    expect(isValidWebsiteProjectName('a/b')).toBe(false)
    expect(isValidWebsiteProjectName('a\\b')).toBe(false)
    // 冒号是引擎 bind 字符串 source:dest[:mode] 的分隔符，混入会把 bind 源截断。
    expect(isValidWebsiteProjectName('a:b')).toBe(false)
    expect(isValidWebsiteProjectName('a\nb')).toBe(false)
    expect(isValidWebsiteProjectName('a\u0000b')).toBe(false)
    expect(isValidWebsiteProjectName('a\u007fb')).toBe(false)
  })

  it('拒绝相对路径段本身，普通含点名不误伤', () => {
    expect(isValidWebsiteProjectName('.')).toBe(false)
    expect(isValidWebsiteProjectName('..')).toBe(false)
    expect(isValidWebsiteProjectName('a.b')).toBe(true)
  })
})

describe('websiteProjectRootDir 参数化', () => {
  it('缺省挂载根保持演示前缀，WEBSITE_ROOT_BASE 断言不变', () => {
    expect(WEBSITE_ROOT_BASE).toBe('/www/wwwroot')
    expect(websiteProjectRootDir('订单中心-api')).toBe('/www/wwwroot/订单中心-api')
  })

  it('显式挂载根推导站点目录，名称两侧空白先行去除', () => {
    expect(websiteProjectRootDir('company-portal', '/srv')).toBe('/srv/wwwroot/company-portal')
    expect(websiteProjectRootDir('  x  ', '/srv')).toBe('/srv/wwwroot/x')
  })
})

describe('isValidWebsiteDomain 域名判据', () => {
  it('接受 RFC 1123 形态的多级域名', () => {
    expect(isValidWebsiteDomain('example.com')).toBe(true)
    expect(isValidWebsiteDomain('www.example.com')).toBe(true)
    expect(isValidWebsiteDomain('a-b.example.co.uk')).toBe(true)
    expect(isValidWebsiteDomain('WWW.EXAMPLE.COM')).toBe(true)
    // 目录允许的 253 字符上限本身可过：单标签无 63 位约束是既定口径。
    expect(isValidWebsiteDomain(`${'a'.repeat(249)}.com`)).toBe(true)
  })

  it('拒绝空串、单标签、尾点与非法标签形态', () => {
    expect(isValidWebsiteDomain('')).toBe(false)
    expect(isValidWebsiteDomain('   ')).toBe(false)
    expect(isValidWebsiteDomain('localhost')).toBe(false)
    expect(isValidWebsiteDomain('example.com.')).toBe(false)
    expect(isValidWebsiteDomain('-example.com')).toBe(false)
    expect(isValidWebsiteDomain('example-.com')).toBe(false)
    expect(isValidWebsiteDomain('exa mple.com')).toBe(false)
    expect(isValidWebsiteDomain('under_score.example.com')).toBe(false)
    expect(isValidWebsiteDomain('例え.jp')).toBe(false)
    expect(isValidWebsiteDomain(`${'a'.repeat(250)}.com`)).toBe(false)
  })

  it('拒绝 IP 字面量与通配符', () => {
    expect(isValidWebsiteDomain('192.168.1.1')).toBe(false)
    expect(isValidWebsiteDomain('127.0.0.1')).toBe(false)
    expect(isValidWebsiteDomain('*.example.com')).toBe(false)
    expect(isValidWebsiteDomain('[::1]')).toBe(false)
  })
})

describe('动态运行时目录', () => {
  const report: WebsiteRuntimeCatalogReport = {
    fetchedAt: '2026-09-30T00:00:00.000Z', stale: false, detail: null,
    catalog: {
      java: [{ version: '17.0.1+12', image: 'eclipse-temurin:17.0.1_12-jre', maintenance: 'legacy', checkedAt: '2026-09-30' }],
      node: [{ version: '24.21.0', image: 'node:24.21.0', maintenance: 'maintained', checkedAt: '2026-09-30' }],
      go: [{ version: '1.16.7', image: 'golang:1.16.7', maintenance: 'legacy', checkedAt: '2026-09-30' }],
      python: [{ version: '3.9.7', image: 'python:3.9.7-slim', maintenance: 'legacy', checkedAt: '2026-09-30' }],
    },
  }
  it('从提供的目录解析镜像，不依赖固定版本表', () => {
    expect('WEBSITE_RUNTIME_CATALOG' in contracts).toBe(false)
    expect(isWebsiteRuntimeReleaseVersion('node', '24.21.0')).toBe(true)
    const parsed = parseWebsiteRuntimeCatalogReport(report)
    expect(websiteRuntimeImageRef('java', '17.0.1+12', parsed.catalog)).toBe('eclipse-temurin:17.0.1_12-jre')
    expect(websiteRuntimeImageRef('node', '24.21.0', parsed.catalog)).toBe('node:24.21.0')
    expect(websiteRuntimeImageRef('node', '99.9.9', parsed.catalog)).toBeNull()
    expect(websiteRuntimeImageRef('html', null)).toBe('nginx:1.30.4-alpine3.24')
    const initial = structuredClone(report)
    initial.catalog.java = [{ ...initial.catalog.java[0]!, version: '17.0.0+35', image: 'eclipse-temurin:17_35-jre' }]
    expect(websiteRuntimeImageRef('java', '17.0.0+35', parseWebsiteRuntimeCatalogReport(initial).catalog)).toBe('eclipse-temurin:17_35-jre')
  })
  it('拒绝预发布、浮动标签、重复版本和版本／镜像不匹配', () => {
    expect(isWebsiteRuntimeReleaseVersion('node', '24.21.0-rc.1')).toBe(false)
    for (const change of [
      { version: '24.21.0-rc.1' }, { image: 'node:latest' }, { image: 'node:23.0.0' },
    ]) {
      const bad = structuredClone(report)
      bad.catalog.node = [{ ...bad.catalog.node[0]!, ...change }]
      expect(() => parseWebsiteRuntimeCatalogReport(bad)).toThrow('正式运行时版本目录响应无效')
    }
    const bad = structuredClone(report)
    bad.catalog.node = [bad.catalog.node[0]!, bad.catalog.node[0]!]
    expect(() => parseWebsiteRuntimeCatalogReport(bad)).toThrow('正式运行时版本目录响应无效')
    expect(isWebsiteRuntimeReleaseVersion('java', '28-ea')).toBe(false)
    expect(isWebsiteRuntimeReleaseVersion('go', '1.28beta1')).toBe(false)
    expect(isWebsiteRuntimeReleaseVersion('python', '3.15.0rc3')).toBe(false)
    for (const version of ['17', '17+35']) {
      expect(isWebsiteRuntimeReleaseVersion('java', version)).toBe(false)
      const short = structuredClone(report)
      short.catalog.java = [{ ...short.catalog.java[0]!, version }]
      expect(() => parseWebsiteRuntimeCatalogReport(short)).toThrow('正式运行时版本目录响应无效')
    }
  })
})

describe('websiteDefaultDeployCommand 缺省启动命令', () => {
  it('java、node、go 与 python 必须填写命令，HTML 使用固定 Nginx 命令', () => {
    expect(websiteDefaultDeployCommand('java')).toBe(null)
    expect(websiteDefaultDeployCommand('node')).toBe(null)
    expect(websiteDefaultDeployCommand('go')).toBe(null)
    expect(websiteDefaultDeployCommand('python')).toBe(null)
    expect(websiteDefaultDeployCommand('html')).toBe('nginx -g daemon off;')
  })
})

describe('反向代理通道状态枚举', () => {
  it('取值与中文标签一一对应', () => {
    expect([...WEBSITE_PROXY_STATES]).toEqual(['active', 'unavailable'])
    expect(WEBSITE_PROXY_STATE_LABELS.active).toBe('正常')
    expect(WEBSITE_PROXY_STATE_LABELS.unavailable).toBe('不可用')
    expect(Object.keys(WEBSITE_PROXY_STATE_LABELS).sort()).toEqual([...WEBSITE_PROXY_STATES].sort())
  })
})

describe('操作日志分类新增网站管理', () => {
  it('登记 websites 取值与标签', () => {
    expect(OPERATION_LOG_CATEGORIES).toContain('websites')
    expect(OPERATION_LOG_CATEGORY_LABELS.websites).toBe('网站管理')
  })
})

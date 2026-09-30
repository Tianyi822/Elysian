import { describe, expect, it } from 'vitest'
import {
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_CATEGORY_LABELS,
} from '../logs/platformLogs.ts'
import {
  WEBSITE_PROXY_STATES,
  WEBSITE_PROXY_STATE_LABELS,
  WEBSITE_ROOT_BASE,
  WEBSITE_RUNTIME_VERSIONS,
  isValidWebsiteDomain,
  isValidWebsiteProjectName,
  websiteDefaultDeployCommand,
  websiteProjectRootDir,
  websiteRuntimeImageRef,
} from './websites.ts'

describe('isValidWebsiteProjectName 收紧为路径段判据', () => {
  it('保留原有口径：去空白后 1–64 字符', () => {
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

describe('websiteRuntimeImageRef 镜像引用的唯一权威', () => {
  it('四个官方库按契约目录内版本生成钉死引用', () => {
    expect(websiteRuntimeImageRef('java', '17')).toBe('eclipse-temurin:17.0.20.1_1-jre')
    expect(websiteRuntimeImageRef('node', '20.20.2')).toBe('node:20.20.2')
    expect(websiteRuntimeImageRef('go', '1.23.12')).toBe('golang:1.23.12')
    expect(websiteRuntimeImageRef('python', '3.11.16')).toBe('python:3.11.16-slim')
  })

  it('目录外版本、latest、空版本被拒绝，HTML 使用固定镜像', () => {
    expect(websiteRuntimeImageRef('node', 'latest')).toBe(null)
    expect(websiteRuntimeImageRef('node', '99.9.9')).toBe(null)
    expect(websiteRuntimeImageRef('node', null)).toBe(null)
    expect(websiteRuntimeImageRef('html', null)).toBe('nginx:1.30.4-alpine3.24')
  })

  it('契约目录内每个版本都能映射出镜像引用', () => {
    for (const kind of ['java', 'node', 'go', 'python'] as const) {
      for (const version of WEBSITE_RUNTIME_VERSIONS[kind]) {
        expect(websiteRuntimeImageRef(kind, version), `${kind} ${version}`).not.toBe(null)
      }
    }
  })
})

describe('websiteDefaultDeployCommand 缺省启动命令', () => {
  it('python 用内置 http.server 服务 /app，端口内嵌', () => {
    expect(websiteDefaultDeployCommand('python', 8000)).toBe(
      'python3 -m http.server 8000 --bind 0.0.0.0 --directory /app',
    )
  })

  it('node 内嵌一行式静态文件服务脚本，单引号包裹且端口内嵌', () => {
    const command = websiteDefaultDeployCommand('node', 3000)
    expect(command).not.toBe(null)
    expect(command!.startsWith("node -e '")).toBe(true)
    expect(command!.endsWith("'")).toBe(true)
    expect(command!).toContain('.listen(3000)')
    expect(command!).not.toContain('\n')
    expect(websiteDefaultDeployCommand('node', 3100)).toContain('.listen(3100)')
  })

  it('java 与 go 必须填写命令，HTML 使用固定 Nginx 命令', () => {
    expect(websiteDefaultDeployCommand('java', 8080)).toBe(null)
    expect(websiteDefaultDeployCommand('go', 9100)).toBe(null)
    expect(websiteDefaultDeployCommand('html', 8088)).toBe('nginx -g daemon off;')
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

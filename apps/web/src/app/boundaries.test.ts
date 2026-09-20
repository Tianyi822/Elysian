import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 浏览器侧的边界守卫。
 *
 * 01 号票的验收标准里写着「浏览器依赖图里没有 Cordis 运行时，也没有 Node 专属 API」。
 * 契约包已经有源码扫描守着零依赖，这里补上同样的一道，守住 Web 应用自己的源码：
 * 构建产物干净是最终证据，但等构建才发现太晚，源码扫描能在提交前就拦住。
 */

const WEB_SRC = join(process.cwd(), 'src')

/** 这些文件跑在 Node 里（Vite 开发服务器与预览服务器），不是浏览器代码。 */
const NODE_SIDE_ALLOWLIST = [
  'adapters/sse/mockEventsPlugin.ts',
  'adapters/sse/mockEventsPlugin.node.ts',
  'adapters/sse/mockEventsPlugin.vite.ts',
  'adapters/hostMetrics/metricsStore.ts',
  'adapters/hostMetrics/readHostSample.ts',
  'adapters/hostMetrics/isDockerEnv.ts',
  'adapters/firewallHost/api.ts',
  'adapters/firewallHost/api.node.ts',
  'adapters/firewallHost/hostFiles.node.ts',
  'adapters/firewallHost/firewallApi.vite.ts',
  'adapters/sshHost/api.ts',
  'adapters/sshHost/api.node.ts',
  'adapters/sshHost/sshApi.vite.ts',
  'adapters/usersHost/api.ts',
  'adapters/usersHost/api.node.ts',
  'adapters/usersHost/usersApi.vite.ts',
  'adapters/endpointGuard/guard.ts',
]

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(WEB_SRC, join(entry.parentPath, entry.name)))
}

/** 只扫运行时源码：测试文件本身会引用这些字符串（正则、白名单），扫进来就是自指。 */
function listRuntimeFiles(): string[] {
  return listSourceFiles(WEB_SRC).filter(
    (file) =>
      !file.endsWith('.test.ts') &&
      !file.endsWith('.test.tsx') &&
      !file.startsWith('test/') &&
      !NODE_SIDE_ALLOWLIST.includes(file),
  )
}

describe('浏览器侧边界', () => {
  it('运行时代码不引入 Node 专属模块', () => {
    const files = listRuntimeFiles()
    expect(files.length).toBeGreaterThan(20)

    for (const file of files) {
      const source = readFileSync(join(WEB_SRC, file), 'utf8')
      expect(source, `${file} 不应引入 Node 专属模块`).not.toMatch(/from 'node:/)
    }
  })

  it('运行时代码不引入 Cordis 运行时', () => {
    for (const file of listRuntimeFiles()) {
      const source = readFileSync(join(WEB_SRC, file), 'utf8')
      expect(source, `${file} 不应依赖 cordis`).not.toMatch(/from ['"]cordis/)
      expect(source, `${file} 不应依赖 @deepseek-ai/cordis`).not.toMatch(/@deepseek-ai\/cordis/)
    }
  })
})

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { ServerResponse } from 'node:http'
import type { Connect } from 'vite'
import { isDockerEnv } from '../hostMetrics/isDockerEnv.ts'
import {
  DEFAULT_FIREWALL_PATHS,
  createFirewallService,
  restoreIfNeeded,
  type FirewallHostDeps,
} from './firewallService'
import { FIREWALL_SQLITE_PATH, openRuleTimesStore } from './ruleTimesStore'
import { createFirewallApiHandler } from './api'

const execFileAsync = promisify(execFile)

/*
 * 真实防火墙中间件的 Node 侧接线。硬边界：只有 ELSYIAN_DOCKER=1 且当前进程
 * 真的运行在容器内（/.dockerenv 存在）才可用；否则一律 503，绝不落到宿主机执行。
 */

function execToStdout(file: string, args: readonly string[]): Promise<string> {
  return execFileAsync(file, [...args]).then(
    ({ stdout }) => stdout,
    (error: unknown) => {
      const detail =
        error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '').trim()
          : ''
      throw new Error(detail || (error instanceof Error ? error.message : String(error)))
    },
  )
}

function createHostDeps(): FirewallHostDeps {
  return {
    runUfw: (args) => execToStdout('ufw', args),
    runSs: () => execToStdout('ss', ['-Hultn']),
    runIptables: (args) => execToStdout('iptables', args),
    runIp6tables: (args) => execToStdout('ip6tables', args),
    readText: (path) => readFile(path, 'utf8'),
    writeText: (path, content) => writeFile(path, content, 'utf8'),
    async exists(path) {
      return existsSync(path)
    },
    nowIso: () => new Date().toISOString(),
    paths: DEFAULT_FIREWALL_PATHS,
  }
}

/** 挂载到 /api/security/firewall 的 connect 中间件。 */
export function createSecurityFirewallMiddleware(): Connect.NextHandleFunction {
  const available = isDockerEnv() && existsSync('/.dockerenv')
  if (!available) {
    return createFirewallApiHandler({ available: false })
  }

  const deps = createHostDeps()
  // 规则时间账本持久化在命名卷；打开失败不拖垮端点，退回会话账本。
  try {
    mkdirSync(dirname(FIREWALL_SQLITE_PATH), { recursive: true })
    deps.ruleTimes = openRuleTimesStore(FIREWALL_SQLITE_PATH)
  } catch (error) {
    console.error('[elysian] 防火墙时间账本打开失败，退回会话账本：', error instanceof Error ? error.message : error)
  }
  const service = createFirewallService(deps)
  // 容器重启后内核规则已失、ufw.conf 仍记 ENABLED=yes：启动时装载一次（失败不拖垮 dev server）。
  void restoreIfNeeded(deps).catch((error: unknown) => {
    console.error('[elysian] ufw 启动恢复失败：', error instanceof Error ? error.message : error)
  })

  const handler = createFirewallApiHandler({ available: true, service })
  return (req, res: ServerResponse) => handler(req, res)
}

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { FirewallAdapter } from '@elysian/contracts'
import { resolveAvailability } from '../shared/availability.ts'
import {
  DEFAULT_FIREWALL_PATHS,
  createFirewallService,
  restoreIfNeeded,
  type FirewallHostDeps,
} from './firewallService.ts'
import { writeHostFile } from './hostFiles.ts'

const execFileAsync = promisify(execFile)

/*
 * 真实防火墙服务层的 Node 侧接线（server 进程内）。硬边界：只有 ELYSIAN_DOCKER=1
 * 且当前进程真的运行在容器内（/.dockerenv 存在）才可用；否则路由整片 503，
 * 绝不落到宿主机执行。落盘方式（原子写、内核接口直写）在 hostFiles，由 Vitest 单独覆盖。
 */

/** 路由工厂的注入形状：available=false 时整片 503；service 由本接线装配，测试可注入 fake。 */
export type FirewallDeps = {
  /** false 时一切请求 503：不在容器内的强制保护（见 resolveAvailability 的判据）。 */
  available: boolean
  service?: FirewallAdapter
  /** 真实接线（available 时恒有）：装配层用它构造端口自动开放闭包注入其他域。 */
  hostDeps?: FirewallHostDeps
}

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
    writeText: (path, content) => writeHostFile(path, content),
    async exists(path) {
      return existsSync(path)
    },
    nowIso: () => new Date().toISOString(),
    paths: DEFAULT_FIREWALL_PATHS,
  }
}

/** 装配防火墙路由依赖：容器边界判定 + 真实接线（规则时间账本与启动恢复）。 */
export async function resolveFirewallDeps(): Promise<FirewallDeps> {
  const available = resolveAvailability(process.env, existsSync('/.dockerenv'))
  if (!available) {
    return { available: false }
  }

  const deps = createHostDeps()
  // 规则时间账本依赖 bun:sqlite（仅 Bun 运行时提供）：动态加载，非容器环境（含 vitest）
  // 不进模块图——app.ts 静态引到本模块也不会牵出 bun:sqlite。
  const { FIREWALL_SQLITE_PATH, openRuleTimesStore } = await import('./ruleTimesStore.ts')
  // 规则时间账本持久化在命名卷；打开失败不拖垮端点，退回会话账本。
  try {
    mkdirSync(dirname(FIREWALL_SQLITE_PATH), { recursive: true })
    deps.ruleTimes = openRuleTimesStore(FIREWALL_SQLITE_PATH)
  } catch (error) {
    console.error('[elysian] 防火墙时间账本打开失败，退回会话账本：', error instanceof Error ? error.message : error)
  }
  const service = createFirewallService(deps)
  // 容器重启后内核规则已失、ufw.conf 仍记 ENABLED=yes：启动时装载一次（失败不拖垮 server）。
  void restoreIfNeeded(deps).catch((error: unknown) => {
    console.error('[elysian] ufw 启动恢复失败：', error instanceof Error ? error.message : error)
  })

  return { available: true, service, hostDeps: deps }
}

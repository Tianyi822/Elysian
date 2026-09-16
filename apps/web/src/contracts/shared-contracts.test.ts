import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as contracts from '@elysian/contracts'
import { DATABASE_ENGINES, DATABASE_STATUS_LABELS, DATABASE_STATUSES } from '@elysian/contracts'

/*
 * 契约包的契约测试：枚举与标签表一一对应、职责模块词典完整、事件模式齐备，
 * 以及本包保持零运行时依赖。
 */

const ENUM_TABLES: ReadonlyArray<{
  name: string
  values: readonly string[]
  labels: Record<string, string>
}> = [
  { name: 'Severity', values: contracts.SEVERITIES, labels: contracts.SEVERITY_LABELS },
  {
    name: 'IncidentStatus',
    values: contracts.INCIDENT_STATUSES,
    labels: contracts.INCIDENT_STATUS_LABELS,
  },
  { name: 'RunStatus', values: contracts.RUN_STATUSES, labels: contracts.RUN_STATUS_LABELS },
  { name: 'AgentStatus', values: contracts.AGENT_STATUSES, labels: contracts.AGENT_STATUS_LABELS },
  {
    name: 'TurnEndReason',
    values: contracts.TURN_END_REASONS,
    labels: contracts.TURN_END_REASON_LABELS,
  },
  {
    name: 'ApprovalStatus',
    values: contracts.APPROVAL_STATUSES,
    labels: contracts.APPROVAL_STATUS_LABELS,
  },
  {
    name: 'ApprovalOutcome',
    values: contracts.APPROVAL_OUTCOMES,
    labels: contracts.APPROVAL_OUTCOME_LABELS,
  },
  {
    name: 'ApprovalPolicy',
    values: contracts.APPROVAL_POLICIES,
    labels: contracts.APPROVAL_POLICY_LABELS,
  },
  { name: 'RiskLevel', values: contracts.RISK_LEVELS, labels: contracts.RISK_LEVEL_LABELS },
  {
    name: 'SandboxMode',
    values: contracts.SANDBOX_MODES,
    labels: contracts.SANDBOX_MODE_LABELS,
  },
  { name: 'AuditKind', values: contracts.AUDIT_KINDS, labels: contracts.AUDIT_KIND_LABELS },
  {
    name: 'ContainerStatus',
    values: contracts.CONTAINER_STATUSES,
    labels: contracts.CONTAINER_STATUS_LABELS,
  },
  { name: 'RestartPolicy', values: contracts.RESTART_POLICIES, labels: contracts.RESTART_POLICY_LABELS },
  {
    name: 'FirewallRuleStatus',
    values: contracts.FIREWALL_RULE_STATUSES,
    labels: contracts.FIREWALL_RULE_STATUS_LABELS,
  },
  {
    name: 'FirewallPolicy',
    values: contracts.FIREWALL_POLICIES,
    labels: contracts.FIREWALL_POLICY_LABELS,
  },
  {
    name: 'FirewallDirection',
    values: contracts.FIREWALL_DIRECTIONS,
    labels: contracts.FIREWALL_DIRECTION_LABELS,
  },
  {
    name: 'SshServiceStatus',
    values: contracts.SSH_SERVICE_STATUSES,
    labels: contracts.SSH_SERVICE_STATUS_LABELS,
  },
  {
    name: 'SshLoginWindow',
    values: contracts.SSH_LOGIN_WINDOWS,
    labels: contracts.SSH_LOGIN_WINDOW_LABELS,
  },
  {
    name: 'SshRootLoginPolicy',
    values: contracts.SSH_ROOT_LOGIN_POLICIES,
    labels: contracts.SSH_ROOT_LOGIN_POLICY_LABELS,
  },
  {
    name: 'SshPasswordStrength',
    values: contracts.SSH_PASSWORD_STRENGTHS,
    labels: contracts.SSH_PASSWORD_STRENGTH_LABELS,
  },
  {
    name: 'SshLoginResult',
    values: contracts.SSH_LOGIN_RESULTS,
    labels: contracts.SSH_LOGIN_RESULT_LABELS,
  },
  {
    name: 'HostUserStatus',
    values: contracts.HOST_USER_STATUSES,
    labels: contracts.HOST_USER_STATUS_LABELS,
  },
  {
    name: 'HostUserLoginMethod',
    values: contracts.HOST_USER_LOGIN_METHODS,
    labels: contracts.HOST_USER_LOGIN_METHOD_LABELS,
  },
]

describe('枚举与中文标签表', () => {
  it.each(ENUM_TABLES)('$name 的取值与标签一一对应，没有多余也没有遗漏', ({ values, labels }) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort())
  })

  it.each(ENUM_TABLES)('$name 的每个取值都有非空标签', ({ values, labels }) => {
    for (const value of values) {
      expect(labels[value]?.trim(), `${value} 缺少标签`).toBeTruthy()
    }
  })

  it.each(ENUM_TABLES)('$name 的取值不重复', ({ values }) => {
    expect(new Set(values).size).toBe(values.length)
  })

  it('严重等级与风险等级是两套独立枚举，不互相赋值', () => {
    expect(contracts.SEVERITIES).not.toEqual(contracts.RISK_LEVELS)
    expect(contracts.SEVERITY_RANK['sev1']).toBe(1)
    expect(contracts.RISK_RANK['critical']).toBe(4)
  })

  it('排序权重覆盖全部取值', () => {
    expect(Object.keys(contracts.SEVERITY_RANK).sort()).toEqual([...contracts.SEVERITIES].sort())
    expect(Object.keys(contracts.RISK_RANK).sort()).toEqual([...contracts.RISK_LEVELS].sort())
  })
})

const EXPECTED_MODULE_NAMES = [
  '指挥协调',
  '应急处置',
  '观测诊断',
  '安全治理',
  '技能管理',
]

describe('职责模块词典', () => {
  it('恰好登记 5 个模块，名称与术语表一致', () => {
    expect(contracts.RESPONSIBILITY_MODULES).toHaveLength(5)
    expect(contracts.RESPONSIBILITY_MODULES.map((module) => module.name)).toEqual(
      EXPECTED_MODULE_NAMES,
    )
  })

  it('模块标识与名称都不重复', () => {
    const ids = contracts.RESPONSIBILITY_MODULES.map((module) => module.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(contracts.RESPONSIBILITY_MODULES.map((module) => [module.name, module] as const))(
    '%s 具备职责、输入、输出、工具范围与风险上限',
    (_name, module) => {
      expect(module.purpose.trim()).toBeTruthy()
      expect(module.inputs.length).toBeGreaterThan(0)
      expect(module.outputs.length).toBeGreaterThan(0)
      expect(module.toolScope.length).toBeGreaterThan(0)
      expect(contracts.RISK_LEVELS).toContain(module.riskCeiling)
    },
  )

  it('按标识查名字，未知标识回落到标识本身', () => {
    expect(contracts.responsibilityModuleName('command-coordination')).toBe('指挥协调')
    expect(contracts.findResponsibilityModule('observability-diagnosis')?.riskCeiling).toBe('medium')
    expect(contracts.responsibilityModuleName('unknown-module')).toBe('unknown-module')
  })
})

describe('类型化事件', () => {
  it('运行期事件名清单与分发模式表完全对应', () => {
    expect([...contracts.EVENT_NAMES].sort()).toEqual(Object.keys(contracts.EVENT_MODES).sort())
  })

  it('每个事件都标注了合法分发模式', () => {
    for (const name of contracts.EVENT_NAMES) {
      expect(['emit', 'waterfall', 'serial', 'parallel']).toContain(contracts.EVENT_MODES[name])
    }
  })

  it('登记了 Elysian 新增的运维域事件', () => {
    expect(contracts.EVENT_NAMES).toContain('incident/created')
    expect(contracts.EVENT_NAMES).toContain('incident/updated')
  })

  it('事件流只承载 emit 型事件，其余模式需要双向通道', () => {
    const streamed = contracts.EVENT_NAMES.filter(
      (name) => contracts.EVENT_MODES[name] === 'emit',
    )
    expect(streamed).toContain('agent/status')
    expect(streamed).toContain('approval/decided')
    expect(streamed).not.toContain('tools/execute')
  })
})

/**
 * 类型层断言：`Context` 上确实挂上了服务键。若 `context-services.ts` 里的
 * `declare module './context'` 扩展失效，`keyof Context` 会是 never，
 * 下面这个常量就会编译报错，不需要等到运行时才发现。
 */
const CONTEXT_KEYS: ReadonlyArray<keyof contracts.Context> = [
  'skills',
  'approvals',
  'audit',
  'incidents',
  'runs',
]

describe('服务容器', () => {
  it('按 Cordis 的 declare module 方式挂载了服务键', () => {
    expect(CONTEXT_KEYS).toHaveLength(5)
  })
})

/** 从当前工作目录向上找到契约包源码，测试无论从仓库根还是从 apps/web 运行都能定位。 */
function findContractsSrc(): string {
  let dir = process.cwd()
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'packages', 'foundation', 'contracts', 'src')
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  throw new Error('找不到契约包源码目录 packages/foundation/contracts/src')
}

const CONTRACTS_SRC = findContractsSrc()

describe('契约包零运行时依赖', () => {
  const FORBIDDEN = [
    { pattern: /from\s+['"]react['"]/, why: '不得依赖 React' },
    { pattern: /from\s+['"]react-dom['"]/, why: '不得依赖 React DOM' },
    { pattern: /\bdocument\./, why: '不得触碰 DOM' },
    { pattern: /\bwindow\./, why: '不得触碰 DOM' },
    { pattern: /\brequire\(/, why: '不得使用 CommonJS require' },
  ]

  it('源码里没有引入运行时库，也没有触碰 DOM', () => {
    const files = readdirSync(CONTRACTS_SRC).filter((file) => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const source = readFileSync(join(CONTRACTS_SRC, file), 'utf8')
      for (const { pattern, why } of FORBIDDEN) {
        expect(source, `${file} ${why}`).not.toMatch(pattern)
      }
    }
  })
})

describe('容器域类型', () => {
  it('状态与策略枚举、类型、标签表一一对应', () => {
    expect(contracts.CONTAINER_STATUSES).toEqual(['running', 'stopped', 'restarting'])
    expect(contracts.CONTAINER_STATUS_LABELS.running).toBe('运行中')
    expect(contracts.RESTART_POLICIES).toEqual(['no', 'always', 'on-failure', 'unless-stopped'])
    expect(contracts.RESTART_POLICY_LABELS['unless-stopped']).toBe('除非手动停止')
  })
})

describe('容器事件', () => {
  it('container/sample 与 container/updated 已登记且均为 emit 模式', () => {
    expect(contracts.EVENT_NAMES).toContain('container/sample')
    expect(contracts.EVENT_NAMES).toContain('container/updated')
    expect(contracts.EVENT_MODES['container/sample']).toBe('emit')
    expect(contracts.EVENT_MODES['container/updated']).toBe('emit')
  })
})

describe('数据库域词典', () => {
  it('四个引擎按首字母升序，暂未接入的 MongoDB 与 PgSQL 不在清单内', () => {
    expect([...DATABASE_ENGINES]).toEqual([
      'MariaDB',
      'MySQL',
      'Redis',
      'SQLite',
    ])
    expect(DATABASE_ENGINES).not.toContain('MongoDB')
    expect(DATABASE_ENGINES).not.toContain('PgSQL')
    expect(DATABASE_ENGINES).not.toContain('SQLServer')
  })

  it('状态取值与中文标签一一对应', () => {
    expect([...DATABASE_STATUSES]).toEqual(['running', 'warning', 'stopped'])
    expect(Object.keys(DATABASE_STATUS_LABELS).sort()).toEqual([...DATABASE_STATUSES].sort())
  })
})

describe('SSH 域词典', () => {
  it('Root 登录策略沿用 sshd_config 的 PermitRootLogin，四档齐备且文案不带技术符号', () => {
    expect([...contracts.SSH_ROOT_LOGIN_POLICIES]).toEqual([
      'no',
      'prohibit-password',
      'forced-commands-only',
      'yes',
    ])
    expect(contracts.SSH_ROOT_LOGIN_POLICY_LABELS['prohibit-password']).toBe('只能密钥登录')
    expect(contracts.SSH_ROOT_LOGIN_POLICY_LABELS['forced-commands-only']).toBe('仅允许指定命令')
  })

  it('统计窗口按今日、昨日、近 7 天的顺序排列', () => {
    expect([...contracts.SSH_LOGIN_WINDOWS]).toEqual(['today', 'yesterday', 'last7Days'])
  })

  it('端口判据只接受 1-65535 的整数，默认端口为 22', () => {
    expect(contracts.SSH_DEFAULT_PORT).toBe(22)
    expect(contracts.isValidSshPort(1)).toBe(true)
    expect(contracts.isValidSshPort(65535)).toBe(true)
    expect(contracts.isValidSshPort(0)).toBe(false)
    expect(contracts.isValidSshPort(65536)).toBe(false)
    expect(contracts.isValidSshPort(22.5)).toBe(false)
  })

  it('密钥名称判据：去空白后非空且不超上限', () => {
    expect(contracts.SSH_KEY_NAME_MAX_LENGTH).toBe(32)
    expect(contracts.isValidSshKeyName('部署机')).toBe(true)
    expect(contracts.isValidSshKeyName('  CI 发布  ')).toBe(true)
    expect(contracts.isValidSshKeyName('x'.repeat(32))).toBe(true)
    expect(contracts.isValidSshKeyName('   ')).toBe(false)
    expect(contracts.isValidSshKeyName('x'.repeat(33))).toBe(false)
  })
})

describe('主机账号域词典', () => {
  it('账号状态与登录方式是两套独立枚举，取值与中文标签一一对应', () => {
    expect([...contracts.HOST_USER_STATUSES]).toEqual(['active', 'disabled'])
    expect(contracts.HOST_USER_STATUS_LABELS.disabled).toBe('已停用')
    expect([...contracts.HOST_USER_LOGIN_METHODS]).toEqual([
      'password',
      'key',
      'password-or-key',
      'none',
    ])
    expect(contracts.HOST_USER_LOGIN_METHOD_LABELS.none).toBe('禁止登录')
  })

  it('用户名判据沿用 Linux 取名习惯：小写字母或下划线开头，最长 32 位', () => {
    expect(contracts.isValidHostUserName('wangwu')).toBe(true)
    expect(contracts.isValidHostUserName('deploy_bot-01')).toBe(true)
    expect(contracts.isValidHostUserName('_svc')).toBe(true)
    expect(contracts.isValidHostUserName('Wangwu')).toBe(false)
    expect(contracts.isValidHostUserName('1ops')).toBe(false)
    expect(contracts.isValidHostUserName('wang wu')).toBe(false)
    expect(contracts.isValidHostUserName('wangwu!')).toBe(false)
    expect(contracts.isValidHostUserName('')).toBe(false)
    expect(contracts.isValidHostUserName('x'.repeat(33))).toBe(false)
  })

  // 判定的两条尺子是长度与字符类别：八位起、两类起才算中，十二位且三类起才算强。
  const PASSWORD_CASES = [
    ['12345678', 'weak', '八位但只有一类'],
    ['abcdefgh', 'weak', '八位纯小写'],
    ['Abc1', 'weak', '过短'],
    ['', 'weak', '空密码'],
    ['Abcdefg1', 'medium', '八位三类'],
    ['Abcdefghij1', 'medium', '十一位三类'],
    ['Abcdefghij1!', 'strong', '十二位四类'],
    ['正确密码Abc123456', 'strong', '中文加三类字符'],
  ]

  it.each(PASSWORD_CASES)('弱密码判定：%s 判为 %s（%s）', (password, expected, why) => {
    expect(contracts.evaluateSshPasswordStrength(password), why).toBe(expected)
  })
})

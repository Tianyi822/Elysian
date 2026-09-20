import { describe, expect, it } from 'vitest'
import {
  FORWARD_COMMENT_PREFIX,
  forwardCommentOf,
  forwardIdOf,
  forwardPortsOverlap,
  forwardRowFromSpec,
  natRuleArgsOf,
  noteFromForwardComment,
  parseForwardId,
  parseForwardSection,
  parseOurNatRuleNumbers,
  setForwardSection,
  specFromForwardInput,
  type ForwardSpec,
} from './forwardRules'
import { PANEL_PORT } from './panelPort'

const BASE_RULES = `*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
COMMIT`

describe('parseForwardSection / setForwardSection', () => {
  it('无段返回空，写入后可解析回规范，且段落在文件最前', () => {
    expect(parseForwardSection(BASE_RULES)).toEqual([])

    const spec = { protocol: 'tcp' as const, port: '8080', targetHost: '10.0.0.5', targetPort: 80, note: '博客上游' }
    const next = setForwardSection(BASE_RULES, [spec])
    expect(parseForwardSection(next)).toEqual([spec])
    // nat 段在文件最前（ufw 官方文档的 nat 位置），filter 表原内容不动
    expect(next.startsWith('### ELYSIAN 端口转发')).toBe(true)
    expect(next).toContain('-A ufw-before-input -i lo -j ACCEPT')
    expect(next).toContain('*nat')
    // comment 用双引号：iptables-restore 只认双引号，单引号会被按空白切开
    expect(next).toContain(`-A PREROUTING -p tcp --dport 8080 -m comment --comment "${FORWARD_COMMENT_PREFIX} 博客上游" -j DNAT --to-destination 10.0.0.5:80`)
  })

  it('remark 含单引号可安全存活（double quote 才是保留字符）', () => {
    const spec = { protocol: 'tcp' as const, port: '8080', targetHost: '10.0.0.5', targetPort: 80, note: "运维's 转发" }
    const parsed = parseForwardSection(setForwardSection(BASE_RULES, [spec]))
    expect(parsed[0]?.note).toBe(spec.note)
  })

  it('备注带中文/空格时经 comment 往返无损，单引号被拒绝在输入校验', () => {
    const spec = { protocol: 'udp' as const, port: '53', targetHost: '10.0.0.53', targetPort: 53, note: '内网 DNS · 解析' }
    const parsed = parseForwardSection(setForwardSection(BASE_RULES, [spec]))
    expect(parsed[0]?.note).toBe(spec.note)
  })

  it('多条规范一次写入、按 id 检索；清空回到原文', () => {
    const specs = [
      { protocol: 'tcp' as const, port: '8080', targetHost: '10.0.0.5', targetPort: 80, note: null },
      { protocol: 'tcp' as const, port: '1000:2000', targetHost: '10.0.0.9', targetPort: 3000, note: null },
    ]
    const next = setForwardSection(BASE_RULES, specs)
    expect(parseForwardSection(next)).toEqual(specs)
    expect(setForwardSection(next, [])).toBe(BASE_RULES)
  })

  it('重复应用幂等：同一集合写两次内容一致', () => {
    const spec = { protocol: 'tcp' as const, port: '8080', targetHost: '10.0.0.5', targetPort: 80, note: null }
    const once = setForwardSection(BASE_RULES, [spec])
    expect(setForwardSection(once, [spec])).toBe(once)
  })
})

describe('comment 标记', () => {
  it('带标记的 comment 可还原备注，无标记返回 null', () => {
    expect(noteFromForwardComment(forwardCommentOf('博客'))).toBe('博客')
    expect(noteFromForwardComment(forwardCommentOf(null))).toBeNull()
    expect(noteFromForwardComment('别人的规则')).toBeNull()
  })

  it('超长备注截断到 iptables 允许的长度', () => {
    const long = 'x'.repeat(400)
    expect(forwardCommentOf(long).length).toBeLessThanOrEqual(200)
  })
})

describe('natRuleArgsOf', () => {
  it('生成 -A 之后的 iptables 参数（带标记 comment）', () => {
    const args = natRuleArgsOf({ protocol: 'tcp', port: '8080', targetHost: '10.0.0.5', targetPort: 80, note: '博客' })
    expect(args).toEqual([
      '-p', 'tcp',
      '--dport', '8080',
      '-m', 'comment', '--comment', `${FORWARD_COMMENT_PREFIX} 博客`,
      '-j', 'DNAT',
      '--to-destination', '10.0.0.5:80',
    ])
  })
})

describe('parseOurNatRuleNumbers', () => {
  it('从 iptables -L 输出挑出本面板规则的行号（升序），别人的规则不动', () => {
    const listing = [
      'Chain PREROUTING (policy ACCEPT)',
      'num  target     prot opt source               destination',
      '1    DNAT       tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:8080 to:10.0.0.5:80',
      '2    DNAT       tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:9090 /* ELYSIAN-FWD 新转发 */ to:10.0.0.20:80',
      '3    MASQUERADE  all  --  172.17.0.0/16        0.0.0.0/0',
      '4    DNAT       udp  --  0.0.0.0/0            0.0.0.0/0            udp dpt:53 /* ELYSIAN-FWD */ to:10.0.0.53:53',
    ].join('\n')
    expect(parseOurNatRuleNumbers(listing)).toEqual([2, 4])
  })

  it('没有本面板规则时返回空数组', () => {
    expect(parseOurNatRuleNumbers('Chain PREROUTING (policy ACCEPT)\n')).toEqual([])
  })
})

describe('forwardIdOf / parseForwardId', () => {
  it('id 往返：规范 → id → 规范（备注不参与身份）', () => {
    const spec = { protocol: 'tcp' as const, port: '1000:2000', targetHost: '10.0.0.5', targetPort: 80, note: 'x' }
    const id = forwardIdOf(spec)
    const parsed = parseForwardId(id)
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ protocol: 'tcp', port: '1000:2000', targetHost: '10.0.0.5', targetPort: 80 })
    expect(parseForwardId('not-a-forward-id')).toBeNull()
  })
})

describe('specFromForwardInput', () => {
  const base = { protocol: 'tcp' as const, port: 8080, targetHost: '10.0.0.5', targetPort: 80, note: null }

  it('单端口与端口段映射为规范', () => {
    expect(specFromForwardInput(base)).toMatchObject({ port: '8080' })
    expect(specFromForwardInput({ ...base, port: 1000, portTo: 2000 })).toMatchObject({ port: '1000:2000' })
  })

  it('目标地址必须是 IPv4，端口与段校验给中文错误', () => {
    expect(() => specFromForwardInput({ ...base, targetHost: 'fd00::1' })).toThrow('目标地址无效')
    expect(() => specFromForwardInput({ ...base, targetHost: 'example.com' })).toThrow('目标地址无效')
    expect(() => specFromForwardInput({ ...base, port: 0 })).toThrow('外部端口无效')
    expect(() => specFromForwardInput({ ...base, port: 2000, portTo: 1000 })).toThrow('端口段无效')
    expect(() => specFromForwardInput({ ...base, targetPort: 70000 })).toThrow('目标端口无效')
    // comment 用双引号包住，备注里的双引号会破坏规则文本
    expect(() => specFromForwardInput({ ...base, note: '外层"引号' })).toThrow('备注不能包含双引号')
  })

  it('目标地址拒绝 CIDR 网段：iptables-restore 只接受单个 IPv4，写出 10.0.0.0/24 这类目标是装载失败的坏规则', () => {
    expect(() => specFromForwardInput({ ...base, targetHost: '10.0.0.0/24' })).toThrow('目标地址无效')
    expect(() => specFromForwardInput({ ...base, targetHost: '10.0.0.5/32' })).toThrow('目标地址无效')
    expect(specFromForwardInput({ ...base, targetHost: '10.0.0.5' })).toMatchObject({ targetHost: '10.0.0.5' })
  })

  it('外部端口等于面板端口被拒绝：DNAT 会把工作台自身的流量劫走，绕过保底放行', () => {
    expect(() => specFromForwardInput({ ...base, port: PANEL_PORT })).toThrow('面板端口不允许配置转发')
  })

  it('外部端口段覆盖面板端口被拒绝（区间含端点）', () => {
    expect(() => specFromForwardInput({ ...base, port: 1000, portTo: 6000 })).toThrow('面板端口不允许配置转发')
    expect(() => specFromForwardInput({ ...base, port: 1, portTo: PANEL_PORT })).toThrow('面板端口不允许配置转发')
    expect(() => specFromForwardInput({ ...base, port: PANEL_PORT, portTo: 6000 })).toThrow('面板端口不允许配置转发')
    expect(() => specFromForwardInput({ ...base, protocol: 'udp', port: 1000, portTo: PANEL_PORT })).toThrow('面板端口不允许配置转发')
  })

  it('不覆盖面板端口的端口段正常通过', () => {
    expect(specFromForwardInput({ ...base, port: 5000, portTo: PANEL_PORT - 1 })).toMatchObject({ port: `5000:${PANEL_PORT - 1}` })
    expect(specFromForwardInput({ ...base, port: PANEL_PORT + 1, portTo: 6000 })).toMatchObject({ port: `${PANEL_PORT + 1}:6000` })
  })

  it('备注含换行或回车被拒绝，正常备注不受影响', () => {
    // 换行会把 before.rules 里的一行规则断成两行，iptables-restore 随之解析失败
    expect(() => specFromForwardInput({ ...base, note: '第一行\n第二行' })).toThrow('备注不能包含换行')
    expect(() => specFromForwardInput({ ...base, note: '第一行\r第二行' })).toThrow('备注不能包含换行')
    expect(specFromForwardInput({ ...base, note: '博客上游 8080' })).toMatchObject({ note: '博客上游 8080' })
  })
})

describe('forwardRowFromSpec', () => {
  it('端口段展开为 port + portTo', () => {
    const row = forwardRowFromSpec(
      { protocol: 'tcp', port: '1000:2000', targetHost: '10.0.0.5', targetPort: 80, note: null },
      '2026-09-19T08:00:00.000Z',
    )
    expect(row).toMatchObject({ port: 1000, portTo: 2000, targetHost: '10.0.0.5', targetPort: 80, updatedAt: '2026-09-19T08:00:00.000Z' })
  })
})

describe('forwardPortsOverlap', () => {
  const spec = (port: string): ForwardSpec => ({ protocol: 'tcp', port, targetHost: '10.0.0.5', targetPort: 80, note: null })

  it('同协议下端口区间相交即冲突：单端口落入区间、区间交叠、端点重叠', () => {
    expect(forwardPortsOverlap(spec('1000:2000'), spec('1500'))).toBe(true)
    expect(forwardPortsOverlap(spec('1000:2000'), spec('2000:3000'))).toBe(true)
    expect(forwardPortsOverlap(spec('1500'), spec('1000:2000'))).toBe(true)
    expect(forwardPortsOverlap(spec('8080'), spec('8080'))).toBe(true)
  })

  it('区间不相交或协议不同都不冲突', () => {
    expect(forwardPortsOverlap(spec('1000:2000'), spec('2001:3000'))).toBe(false)
    expect(forwardPortsOverlap(spec('8080'), spec('9090'))).toBe(false)
    expect(forwardPortsOverlap({ ...spec('8080'), protocol: 'udp' }, spec('8080'))).toBe(false)
  })
})

import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const [operation, ...args] = process.argv.slice(2)
const maximumConfigBytes = 4 * 1024 * 1024
const executeFile = promisify(execFile)

function socketPath(value) {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(value) || value.includes('/../') || value.endsWith('/..')) {
    throw new Error('管理 socket 必须是无空白、冒号、引号及控制字符的绝对路径，且不得包含 .. 路径段')
  }
  return value
}

function readConfig(file) {
  const body = fs.readFileSync(file)
  if (body.length > maximumConfigBytes) throw new Error('Caddy 配置响应超过 4 MiB')
  let config
  try { config = JSON.parse(body.toString('utf8')) } catch { throw new Error('Caddy 配置不是有效 JSON') }
  if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('Caddy 配置必须是 JSON 对象或 null')
  }
  return config
}

function endpoint(config) {
  if (config?.admin?.disabled) throw new Error('已有 Caddy 禁用了管理 API，不能安全自动接入')
  const listen = config?.admin?.listen ?? 'localhost:2019'
  if (typeof listen !== 'string') throw new Error('无法识别 Caddy 管理端点')
  if (listen.startsWith('unix/')) return `unix:${socketPath(listen.slice(5))}`
  if (/^(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(listen)) return `tcp:${listen}`
  throw new Error('已有 Caddy 管理端点不是可验证的本机 Unix socket 或回环 TCP 地址')
}

function environmentRecords(text) {
  const lines = text.split(/(?<=\n)/)
  const records = []
  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index]
    const assignment = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s)
    if (!assignment) {
      records.push({ text })
      continue
    }
    const value = assignment[2].trimStart()
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : undefined
    if (quote) {
      let end = 1
      let accumulated = value
      for (;;) {
        while (end < accumulated.length) {
          if (quote === '"' && accumulated[end] === '\\') { end += 2; continue }
          if (accumulated[end] === quote) break
          end += 1
        }
        if (end < accumulated.length) break
        if (++index >= lines.length) throw new Error('EnvironmentFile 存在未闭合引号，拒绝改写')
        text += lines[index]
        accumulated += lines[index]
      }
    } else {
      while (/\\\r?\n$/.test(text)) {
        if (++index >= lines.length) throw new Error('EnvironmentFile 存在未完成的续行，拒绝改写')
        text += lines[index]
      }
    }
    records.push({ key: assignment[1], text })
  }
  return records
}

function environmentKey(value = 'ELYSIAN_CADDY_SOCKET') {
  if (!['ELYSIAN_CADDY_SOCKET', 'ELYSIAN_DOCKER_SOCKET'].includes(value)) throw new Error('不支持的环境配置键')
  return value
}

function environmentValue(records, key = 'ELYSIAN_CADDY_SOCKET') {
  let result = ''
  for (const record of records) {
    if (record.key !== key) continue
    let value = record.text.slice(record.text.indexOf('=') + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) socketPath(value)
    result = value
  }
  return result
}

function readEnvironment(file) {
  if (!fs.existsSync(file)) return []
  if (fs.statSync(file).size > 256 * 1024) throw new Error('EnvironmentFile 超过 256 KiB，拒绝自动读取或改写')
  return environmentRecords(fs.readFileSync(file, 'utf8'))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

async function waitForCaddy([address, output, expected, attemptsText, intervalText, timeoutText]) {
  const attempts = Number(attemptsText)
  const interval = Number(intervalText) * 1000
  const timeout = Number(timeoutText) * 1000
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(interval) || interval < 0 ||
      !Number.isFinite(timeout) || timeout <= 0 || timeout > 30000) throw new Error('Caddy 验证预算无效')
  const deadline = performance.now() + timeout
  const connection = address.startsWith('unix:/')
    ? ['--unix-socket', socketPath(address.slice(5)), 'http://localhost/config/']
    : /^tcp:(localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(address)
      ? [`http://${address.slice(4)}/config/`] : undefined
  if (!connection) throw new Error('Caddy 验证端点无效')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    try {
      const { stdout } = await executeFile('curl', [
        '-sS', '--noproxy', '*', '--connect-timeout', '2', '--max-time', String(Math.min(5000, remaining) / 1000),
        '--max-filesize', String(maximumConfigBytes), '-o', output, '-w', '%{http_code}', ...connection,
      ], { timeout: Math.max(1, Math.floor(Math.min(5000, remaining))), killSignal: 'SIGKILL', maxBuffer: 1024 })
      const actual = stdout === '200' ? readConfig(output) : undefined
      const matches = stdout === '200' && (!expected ||
        JSON.stringify(canonical(readConfig(expected))) === JSON.stringify(canonical(actual)))
      if (matches && performance.now() < deadline) return
    } catch { /* API 不可用或响应不合法时，在同一总预算内重试。 */ }
    const pause = Math.min(interval, deadline - performance.now())
    if (pause > 0 && attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, pause))
  }
  throw new Error('Caddy 管理 API 在总验证预算内未就绪或配置不一致')
}

try {
  switch (operation) {
    case 'socket':
      process.stdout.write(socketPath(args[0]))
      break
    case 'env-read':
      process.stdout.write(environmentValue(readEnvironment(args[0]), environmentKey(args[1])))
      break
    case 'env-write': {
      const key = environmentKey(args[3])
      const records = readEnvironment(args[0])
      environmentValue(records, key)
      const retained = records.filter(record => record.key !== key).map(record => record.text).join('')
      fs.writeFileSync(args[2], `${retained}${retained && !retained.endsWith('\n') ? '\n' : ''}${key}=${socketPath(args[1])}\n`)
      break
    }
    case 'validate':
      readConfig(args[0])
      break
    case 'wait':
      await waitForCaddy(args)
      break
    case 'endpoint':
      process.stdout.write(endpoint(readConfig(args[0])))
      break
    case 'connect': {
      const config = readConfig(args[0]) ?? {}
      config.admin = { ...config.admin, listen: `unix/${socketPath(args[1])}` }
      fs.writeFileSync(args[2], `${JSON.stringify(config)}\n`, { mode: 0o600 })
      break
    }
    case 'equal':
      if (JSON.stringify(canonical(readConfig(args[0]))) !== JSON.stringify(canonical(readConfig(args[1])))) {
        throw new Error('Caddy 实际运行配置与待应用配置不同，不能确认路由及证书保持完整')
      }
      break
    case 'service': {
      const match = args[0].match(/argv\[\]=(.*?) ;/)
      const command = match?.[1].split(/\s+/) ?? []
      const allowed = [
        ['run', '--environ', '--config', args[1]],
        ['run', '--environ', '--config', args[1], '--adapter', 'caddyfile'],
        ['run', '--config', args[1]],
        ['run', '--config', args[1], '--adapter', 'caddyfile'],
      ]
      if (!/^\/[A-Za-z0-9_./-]*caddy$/.test(command[0] ?? '') ||
          !allowed.some(candidate => JSON.stringify(candidate) === JSON.stringify(command.slice(1)))) {
        throw new Error('无法确认 caddy.service 使用标准 Caddyfile 启动方式，拒绝自动接管')
      }
      break
    }
    default:
      throw new Error('未知安装辅助操作')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

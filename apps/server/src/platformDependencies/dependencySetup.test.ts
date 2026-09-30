import { describe, expect, it } from 'vitest'
import { createPlatformDependenciesApp } from './platformDependenciesRoutes.ts'
import { createDependencySetup, type DependencySetup } from './dependencySetup.ts'
import type { HostCommandRunner } from './hostShell.ts'
import { HostCommandError } from './hostShell.ts'
import {
  CADDY_INSTALL_SCRIPT,
  DOCKER_INSTALL_SCRIPT,
  SETUP_FAILURE_BUSY,
  SETUP_FAILURE_CADDYFILE_INVALID,
  SETUP_FAILURE_ENGINE,
  SETUP_FAILURE_GENERIC,
  SETUP_FAILURE_NO_APT,
  SETUP_FAILURE_SOCKET_PATH,
  SETUP_FAILURE_STEP,
} from './dependencySetupScripts.ts'
import { CADDYFILE_GLOBAL_UNCLOSED, ensureCaddyAdminSocket } from './caddyfileAdmin.ts'

const READY = {
  docker: { state: 'ok' as const, detail: null },
  caddy: { state: 'missing' as const, detail: '宿主未提供 Caddy 管理通道' },
}

function hostReturning(output: string, code = 0): HostCommandRunner {
  return {
    async run() {
      return { code, output }
    },
  }
}

const HEADERS = { Host: '127.0.0.1:5173', Origin: 'http://127.0.0.1:5173' }

describe('createDependencySetup', () => {
  it('安装 Caddy：已装好时跳过，失败句原样返回，其余输出只留尾部', async () => {
    const already = createDependencySetup({ host: hostReturning('ELYSIAN_ALREADY\n') })
    await expect(already.run('caddy', 'install')).resolves.toEqual({ ok: true, message: 'Caddy 已经装好' })

    const noApt = createDependencySetup({ host: hostReturning(`${SETUP_FAILURE_NO_APT}\n`, 42) })
    await expect(noApt.run('caddy', 'install')).resolves.toEqual({ ok: false, message: SETUP_FAILURE_NO_APT })

    const apt = createDependencySetup({
      host: hostReturning('Reading package lists\nE: Unable to locate package caddy\n', 100),
    })
    const failed = await apt.run('caddy', 'install')
    expect(failed.ok).toBe(false)
    expect(failed.message.startsWith(`${SETUP_FAILURE_GENERIC}：`)).toBe(true)
    expect(failed.message).toContain('Unable to locate package caddy')
  })

  it('配置管理通道：空文件写入目标地址；已正确则不再写；非法路径不碰宿主', async () => {
    const scripts: string[] = []
    const host: HostCommandRunner = {
      async run(script) {
        scripts.push(script)
        if (script.includes('base64 -w 0')) return { code: 0, output: 'ELYSIAN_EMPTY\n' }
        return { code: 0, output: 'ELYSIAN_DONE\n' }
      },
    }
    const setup = createDependencySetup({ host, socketPath: () => '/run/caddy/admin.sock' })
    await expect(setup.run('caddy', 'configure')).resolves.toEqual({ ok: true, message: '管理端点已写入' })
    expect(scripts[0]).toContain('base64 -w 0')
    const encoded = /printf '%s' '([A-Za-z0-9+/=]*)'/.exec(scripts[1] ?? '')?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(ensureCaddyAdminSocket('', '/run/caddy/admin.sock'))

    const existing = ensureCaddyAdminSocket('', '/run/caddy/admin.sock')
    const encodedExisting = Buffer.from(existing).toString('base64')
    let writes = 0
    const skip = createDependencySetup({
      host: {
        async run(script) {
          if (script.includes('base64 -w 0')) return { code: 0, output: `ELYSIAN_B64:${encodedExisting}\n` }
          writes += 1
          return { code: 0, output: 'ELYSIAN_DONE\n' }
        },
      },
      socketPath: () => '/run/caddy/admin.sock',
    })
    await expect(skip.run('caddy', 'configure')).resolves.toEqual({ ok: true, message: '管理端点已是目标地址' })
    expect(writes).toBe(0)

    const blocked = createDependencySetup({
      host: { async run() { throw new Error('should not run') } },
      socketPath: () => '/tmp/evil.sock',
    })
    await expect(blocked.run('caddy', 'configure')).resolves.toEqual({
      ok: false,
      message: SETUP_FAILURE_SOCKET_PATH,
    })
  })

  it('全局段残缺、引擎错误与意外异常都不把宿主路径带回', async () => {
    const raw = '{\n\tadmin off\n'
    const unclosed = createDependencySetup({
      host: {
        async run() {
          return { code: 0, output: `ELYSIAN_B64:${Buffer.from(raw).toString('base64')}\n` }
        },
      },
      socketPath: () => '/run/caddy/admin.sock',
    })
    await expect(unclosed.run('caddy', 'configure')).resolves.toEqual({
      ok: false,
      message: CADDYFILE_GLOBAL_UNCLOSED,
    })

    const engine = createDependencySetup({
      host: { async run() { throw new HostCommandError(SETUP_FAILURE_ENGINE) } },
    })
    await expect(engine.run('docker', 'install')).resolves.toEqual({ ok: false, message: SETUP_FAILURE_ENGINE })

    const leaked = createDependencySetup({
      host: { async run() { throw new Error('connect ENOENT /secret/docker.sock') } },
    })
    const result = await leaked.run('docker', 'install')
    expect(result).toEqual({ ok: false, message: SETUP_FAILURE_GENERIC })
    expect(result.message).not.toContain('docker.sock')
  })

  it('校验失败句原样返回；同时只跑一步', async () => {
    const invalid = createDependencySetup({
      host: hostReturning(`${SETUP_FAILURE_CADDYFILE_INVALID}\n`, 42),
    })
    await expect(invalid.run('caddy', 'configure')).resolves.toEqual({
      ok: false,
      message: SETUP_FAILURE_CADDYFILE_INVALID,
    })

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const setup = createDependencySetup({
      host: {
        async run() {
          await gate
          return { code: 0, output: 'ELYSIAN_DONE\n' }
        },
      },
    })
    const first = setup.run('caddy', 'install')
    await expect(setup.run('docker', 'enable')).resolves.toEqual({ ok: false, message: SETUP_FAILURE_BUSY })
    release!()
    await expect(first).resolves.toEqual({ ok: true, message: 'Caddy 已安装' })
  })

  it('Docker 安装脚本是官方安装脚本，未知步骤被拒绝', async () => {
    let seen = ''
    const setup = createDependencySetup({
      host: {
        async run(script) {
          seen = script
          return { code: 0, output: 'ELYSIAN_DONE\n' }
        },
      },
    })
    await expect(setup.run('docker', 'install')).resolves.toEqual({ ok: true, message: 'Docker 已安装' })
    expect(seen).toBe(DOCKER_INSTALL_SCRIPT)
    await expect(setup.run('docker', 'configure')).resolves.toEqual({ ok: false, message: SETUP_FAILURE_STEP })
    expect(CADDY_INSTALL_SCRIPT).toContain('apt-get install -y caddy')
  })
})

describe('安装步骤路由', () => {
  function appWith(setup: DependencySetup) {
    return createPlatformDependenciesApp({
      probe: async () => READY,
      setup,
    })
  }

  it('同源 POST 返回结果；跨源不执行；非法步骤 400；失败 422', async () => {
    const calls: string[] = []
    const app = appWith({
      async run(target, step) {
        calls.push(`${target}:${step}`)
        if (step === 'enable') return { ok: false, message: '这一步没有完成' }
        return { ok: true, message: '已完成' }
      },
    })
    const ok = await app.request('/dependencies/setup/caddy/install', { method: 'POST', headers: HEADERS })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, message: '已完成' })
    expect(calls).toEqual(['caddy:install'])

    const denied = await app.request('/dependencies/setup/caddy/configure', {
      method: 'POST',
      headers: { Host: '127.0.0.1:5173', Origin: 'http://evil.example' },
    })
    expect(denied.status).toBe(403)
    expect(calls).toEqual(['caddy:install'])

    const missingOrigin = await app.request('/dependencies/setup/docker/install', {
      method: 'POST',
      headers: { Host: '127.0.0.1:5173' },
    })
    expect(missingOrigin.status).toBe(403)

    const bad = await app.request('/dependencies/setup/docker/configure', { method: 'POST', headers: HEADERS })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: SETUP_FAILURE_STEP })

    const failed = await app.request('/dependencies/setup/caddy/enable', { method: 'POST', headers: HEADERS })
    expect(failed.status).toBe(422)
    expect(await failed.json()).toEqual({ error: '这一步没有完成' })

    const probed = await app.request('/dependencies')
    expect(probed.status).toBe(200)
    expect(await probed.json()).toEqual(READY)
  })
})

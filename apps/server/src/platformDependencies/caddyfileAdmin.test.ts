import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  CADDY_ENABLE_SCRIPT,
  CADDY_INSTALL_SCRIPT,
  DOCKER_ENABLE_SCRIPT,
  DOCKER_INSTALL_SCRIPT,
  READ_CADDYFILE_SCRIPT,
  writeCaddyfileScript,
} from './dependencySetupScripts.ts'
import { caddyAdminDirective, CADDYFILE_GLOBAL_UNCLOSED, ensureCaddyAdminSocket } from './caddyfileAdmin.ts'

const SOCKET = '/run/caddy/admin.sock'

describe('ensureCaddyAdminSocket', () => {
  it('空文件补上只含管理端点的全局段', () => {
    expect(ensureCaddyAdminSocket('', SOCKET)).toBe(`{\n\t${caddyAdminDirective(SOCKET)}\n}\n`)
  })

  it('没有全局段时把管理端点加在站点块前面', () => {
    const source = 'example.com {\n\troot * /srv\n}\n'
    expect(ensureCaddyAdminSocket(source, SOCKET)).toBe(
      `{\n\t${caddyAdminDirective(SOCKET)}\n}\n\nexample.com {\n\troot * /srv\n}\n`,
    )
  })

  it('已有全局段但没有 admin 时插进段内，站点块不动', () => {
    const source = '{\n\temail a@b.c\n}\n\nexample.com {\n}\n'
    const next = ensureCaddyAdminSocket(source, SOCKET)
    expect(next).toContain(`\t${caddyAdminDirective(SOCKET)}\n`)
    expect(next).toContain('email a@b.c')
    expect(next).toContain('example.com {\n}\n')
  })

  it('已有别的 admin 时换成目标地址，不留第二条', () => {
    const source = '{\n\tadmin localhost:2019\n\tadmin off\n}\n'
    const next = ensureCaddyAdminSocket(source, SOCKET)
    expect(next.match(/admin /g)).toHaveLength(1)
    expect(next).toContain(caddyAdminDirective(SOCKET))
    expect(next).not.toContain('localhost:2019')
  })

  it('已经是目标地址则不改内容', () => {
    const source = `{\n\t${caddyAdminDirective(SOCKET)}\n}\n`
    expect(ensureCaddyAdminSocket(source, SOCKET)).toBe(source)
  })

  it('全局段没有结束括号时拒绝改写', () => {
    expect(() => ensureCaddyAdminSocket('{\n\tadmin off\n', SOCKET)).toThrow(CADDYFILE_GLOBAL_UNCLOSED)
  })
})

describe('安装脚本', () => {
  it('语法可被 sh -n 接受，且不把 shell 变量插进常量', () => {
    for (const script of [
      CADDY_INSTALL_SCRIPT,
      CADDY_ENABLE_SCRIPT,
      DOCKER_INSTALL_SCRIPT,
      DOCKER_ENABLE_SCRIPT,
      READ_CADDYFILE_SCRIPT,
      writeCaddyfileScript(`{\n\t${caddyAdminDirective(SOCKET)}\n}\n`),
    ]) {
      expect(() => execFileSync('/bin/sh', ['-n'], { input: script })).not.toThrow()
    }
    expect(CADDY_INSTALL_SCRIPT).toContain('https://dl.cloudsmith.io/public/caddy/stable/gpg.key')
    expect(CADDY_INSTALL_SCRIPT).toContain('apt-get install -y caddy')
    expect(DOCKER_INSTALL_SCRIPT).toContain('https://get.docker.com')
    expect(CADDY_ENABLE_SCRIPT).toContain('RuntimeDirectory=caddy')
  })

  it('写入脚本只携带 base64，不把文件原文放进 shell 引号', () => {
    const content = "{\n\tadmin '\n}\n"
    const script = writeCaddyfileScript(content)
    expect(script).not.toContain("admin '")
    const encoded = /printf '%s' '([A-Za-z0-9+/=]*)'/.exec(script)?.[1]
    expect(encoded).toBeTruthy()
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe(content)
  })
})

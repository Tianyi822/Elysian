import { describe, expect, it, vi } from 'vitest'
import { changePanelPassword } from './passwordChange.ts'
import { InvalidRequestError } from '../shared/errors.ts'
import { createMemoryCredentialsStore } from './credentialsStore.ts'
import { createScryptHasher } from './passwordHasher.ts'
import { runResetPasswordCli, type ResetPasswordIo } from './resetPasswordCli.ts'

/*
 * 改密测试：passwordChange 纯函数（两次一致/长度/写盘与返回值一致/调用形状/校验错误
 * 的 InvalidRequestError 分型）与 resetPasswordCli 的交互流程（注入 reader fake 与
 * 内存 store，不真起交互、不碰 ~/.Elysian）。import resetPasswordCli 本身即验证
 * import.meta.main 门禁：门禁失效时顶层会开始读 stdin，本文件无法安静地完成。
 */

describe('changePanelPassword', () => {
  it('两次不一致：抛 InvalidRequestError「两次输入的密码不一致」，不触发哈希与写盘', async () => {
    const hasher = { hash: vi.fn(async (plain: string) => `hash:${plain}`), verify: vi.fn(async () => false) }
    const credentials = createMemoryCredentialsStore()
    await expect(changePanelPassword({ credentials, hasher }, 'abcdefg1', 'abcdefg2')).rejects.toThrow('两次输入的密码不一致')
    await expect(changePanelPassword({ credentials, hasher }, 'abcdefg1', 'abcdefg2')).rejects.toBeInstanceOf(InvalidRequestError)
    expect(hasher.hash).not.toHaveBeenCalled()
    await expect(credentials.current()).resolves.toBeNull()
  })

  it('长度不足 8 位：抛 InvalidRequestError「密码至少需要 8 位」', async () => {
    const hasher = { hash: vi.fn(async (plain: string) => `hash:${plain}`), verify: vi.fn(async () => false) }
    await expect(changePanelPassword({ credentials: createMemoryCredentialsStore(), hasher }, '1234567', '1234567')).rejects.toThrow('密码至少需要 8 位')
    await expect(changePanelPassword({ credentials: createMemoryCredentialsStore(), hasher }, '1234567', '1234567')).rejects.toBeInstanceOf(InvalidRequestError)
  })

  it('写盘 IO 故障：原样上抛普通 Error，不包装成 InvalidRequestError', async () => {
    const hasher = { hash: vi.fn(async () => 'hash:x'), verify: vi.fn(async () => false) }
    const credentials = {
      current: async () => null,
      write: async () => {
        throw new Error('EACCES: permission denied, open')
      },
    }
    const outcome = changePanelPassword({ credentials, hasher }, 'long-enough-pwd', 'long-enough-pwd')
    await expect(outcome).rejects.toThrow('EACCES')
    await expect(outcome).rejects.not.toBeInstanceOf(InvalidRequestError)
  })

  it('成功：哈希新密码、经 store.write 落盘，返回值与 store 里的一致（含新 passwordChangedAt）', async () => {
    const hasher = createScryptHasher()
    const credentials = createMemoryCredentialsStore()
    const written = await changePanelPassword({ credentials, hasher }, 'new-password-1', 'new-password-1')
    expect(written.username).toBe('admin')
    expect(written.passwordHash).toMatch(/^scrypt:/)
    await expect(hasher.verify('new-password-1', written.passwordHash)).resolves.toBe(true)
    await expect(credentials.current()).resolves.toEqual(written)
  })

  it('注入 fake store 断言调用形状：恰好一次 write、参数是哈希串', async () => {
    const writtenHashes: string[] = []
    const credentials = {
      current: async () => null,
      write: async (hash: string) => {
        writtenHashes.push(hash)
        return { username: 'admin', passwordHash: hash, passwordChangedAt: '2026-10-01T00:00:00.000Z' }
      },
    }
    await changePanelPassword({ credentials, hasher: createScryptHasher() }, 'whatever-long', 'whatever-long')
    expect(writtenHashes).toHaveLength(1)
    expect(writtenHashes[0]).toMatch(/^scrypt:/)
  })
})

/** fake IO：按脚本顺序吐密码输入，记录提示与打印。 */
function scriptedIo(passwords: [string, string], tty: boolean): ResetPasswordIo & { prompts: string[]; printed: string[] } {
  const prompts: string[] = []
  const printed: string[] = []
  const queue = [...passwords]
  return {
    isTTY: () => tty,
    readHidden: async (prompt) => {
      prompts.push(prompt)
      return queue.shift() ?? ''
    },
    readLine: async (prompt) => {
      prompts.push(prompt)
      return queue.shift() ?? ''
    },
    print: (text) => printed.push(text),
    prompts,
    printed,
  }
}

describe('runResetPasswordCli', () => {
  function memoryDeps() {
    return { credentials: createMemoryCredentialsStore(), hasher: createScryptHasher() }
  }

  it('TTY 流程：两次无回显输入、提示文案、成功打印（无 dev 说明行）', async () => {
    const io = scriptedIo(['new-password-1', 'new-password-1'], true)
    const deps = memoryDeps()
    await runResetPasswordCli(io, deps)
    expect(io.prompts).toEqual(['请输入新密码（至少 8 位）：', '请再次输入新密码：'])
    expect(io.printed).toEqual(['面板密码已修改；全部现有登录会话已失效，请重新登录。'])
    await expect(deps.credentials.current()).resolves.toMatchObject({ username: 'admin' })
  })

  it('非 TTY 流程：先提示明文回显，再逐行读', async () => {
    const io = scriptedIo(['new-password-1', 'new-password-1'], false)
    await runResetPasswordCli(io, memoryDeps())
    expect(io.printed[0]).toBe('当前不是交互终端，输入将明文回显')
    expect(io.printed).toContain('面板密码已修改；全部现有登录会话已失效，请重新登录。')
  })

  it('两次不一致：向上抛「两次输入的密码不一致」，不打印成功文案', async () => {
    const io = scriptedIo(['new-password-1', 'different-pwd'], true)
    await expect(runResetPasswordCli(io, memoryDeps())).rejects.toThrow('两次输入的密码不一致')
    expect(io.printed).toEqual([])
  })

  it('过短：向上抛「密码至少需要 8 位」', async () => {
    const io = scriptedIo(['short', 'short'], true)
    await expect(runResetPasswordCli(io, memoryDeps())).rejects.toThrow('密码至少需要 8 位')
  })

  it('ELYSIAN_AUTH_DEV=1 时追加开发固定账号说明行', async () => {
    const previous = process.env.ELYSIAN_AUTH_DEV
    process.env.ELYSIAN_AUTH_DEV = '1'
    try {
      const io = scriptedIo(['new-password-1', 'new-password-1'], true)
      await runResetPasswordCli(io, memoryDeps())
      expect(io.printed).toContain('开发固定账号不受影响（仅开发环境可用）。')
    } finally {
      if (previous === undefined) delete process.env.ELYSIAN_AUTH_DEV
      else process.env.ELYSIAN_AUTH_DEV = previous
    }
  })
})

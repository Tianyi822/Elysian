import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteText, isKernelInterfacePath, writeHostFile } from './hostFiles.node'

/*
 * 规则文件落盘的原子性测试：真实写临时目录与文件（不碰系统路径），
 * 验证「同目录临时文件 + rename」、失败清理，以及内核接口路径不走原子替换
 * （procfs/sysfs 的目录不可写且不支持 rename，原子写法在那里必然失败）。
 * 被覆盖的模块不依赖 bun:sqlite，因此这些断言进得了 Vitest 与 typecheck 门禁。
 */

let dir = ''

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('atomicWriteText', () => {
  it('原子替换：内容更新后目录里只有目标文件，没有残留临时文件', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elysian-atomic-'))
    const path = join(dir, 'before.rules')

    await atomicWriteText(path, '第一版\n')
    await atomicWriteText(path, '第二版\n')

    expect(readFileSync(path, 'utf8')).toBe('第二版\n')
    expect(readdirSync(dir)).toEqual(['before.rules'])
  })

  it('写入失败时清理临时文件，目标文件保持原内容', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elysian-atomic-'))
    const path = join(dir, 'before.rules')
    await atomicWriteText(path, '原内容\n')

    // 目标被目录占位：rename 到已存在目录会失败，模拟落盘中途出错
    const blocked = join(dir, 'blocked')
    mkdirSync(blocked)
    await expect(atomicWriteText(blocked, '新内容\n')).rejects.toThrow()

    expect(readFileSync(path, 'utf8')).toBe('原内容\n')
    expect(readdirSync(dir).sort()).toEqual(['before.rules', 'blocked'])
  })
})

describe('isKernelInterfacePath', () => {
  it('procfs/sysfs 下的路径按内核接口识别，规则文件与备份文件不识别', () => {
    expect(isKernelInterfacePath('/proc/sys/net/ipv4/ip_forward')).toBe(true)
    expect(isKernelInterfacePath('/proc/net/xt_recent/ELYSIAN_SCAN_BANNED')).toBe(true)
    expect(isKernelInterfacePath('/sys/kernel/mm/transparent_hugepage/enabled')).toBe(true)
    expect(isKernelInterfacePath('/etc/ufw/before.rules')).toBe(false)
    expect(isKernelInterfacePath('/etc/ufw/before.rules.elysian')).toBe(false)
    expect(isKernelInterfacePath('/etc/default/ufw')).toBe(false)
  })
})

describe('writeHostFile', () => {
  it('普通文件走原子替换：内容更新且目录里不残留临时文件', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elysian-hostfile-'))
    const path = join(dir, 'before.rules')

    await writeHostFile(path, '第一版\n')
    await writeHostFile(path, '第二版\n')

    expect(readFileSync(path, 'utf8')).toBe('第二版\n')
    expect(readdirSync(dir)).toEqual(['before.rules'])
  })

  it('普通文件的写失败原样抛出，不静默吞掉（内核接口路径同此语义）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'elysian-hostfile-'))
    const missing = join(dir, '不存在的目录', 'before.rules')

    await expect(writeHostFile(missing, '内容\n')).rejects.toThrow()
  })
})

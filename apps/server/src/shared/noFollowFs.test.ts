import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chmodNoFollow, chownNoFollow, isSymbolicLink, writeTextNoFollow } from './noFollowFs.ts'

/*
 * 不跟随符号链接原语的真实文件系统测试：在临时目录里预置符号链接，
 * 断言写入与权限动作绝不作用到链接目标上。只在临时目录操作，不碰系统文件。
 */

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'elysian-nofollow-'))
  tempRoots.push(root)
  return root
}

describe('noFollowFs 符号链接原语', () => {
  it('isSymbolicLink：链接判定 true、普通文件 false、不跟随链接', async () => {
    const root = await createTempRoot()
    const real = join(root, 'real.txt')
    await writeFile(real, 'x', 'utf8')
    const link = join(root, 'link.txt')
    await symlink(real, link)

    expect(await isSymbolicLink(link)).toBe(true)
    expect(await isSymbolicLink(real)).toBe(false)
  })

  it('writeTextNoFollow：最终组件是符号链接时拒绝，链接目标内容不被写穿', async () => {
    const root = await createTempRoot()
    const real = join(root, 'real.txt')
    await writeFile(real, 'original', 'utf8')
    const link = join(root, 'link.txt')
    await symlink(real, link)

    await expect(writeTextNoFollow(link, 'attacker')).rejects.toThrow()
    expect(await readFile(real, 'utf8')).toBe('original')
  })

  it('writeTextNoFollow：普通路径照常写入（中间组件的符号链接不受影响）', async () => {
    const root = await createTempRoot()
    const realDir = join(root, 'real-dir')
    await mkdir(realDir)
    const linkDir = join(root, 'link-dir')
    await symlink(realDir, linkDir)

    await writeTextNoFollow(join(linkDir, 'stamp.txt'), 'ok')
    expect(await readFile(join(realDir, 'stamp.txt'), 'utf8')).toBe('ok')
  })

  it('chmodNoFollow：最终组件是符号链接时拒绝，链接目标权限不被改动', async () => {
    const root = await createTempRoot()
    const real = join(root, 'real.txt')
    await writeFile(real, 'x', 'utf8')
    await chmodNoFollow(real, 0o644)
    const link = join(root, 'link.txt')
    await symlink(real, link)

    await expect(chmodNoFollow(link, 0o600)).rejects.toThrow()
    expect((await stat(real)).mode & 0o777).toBe(0o644)
  })

  it('chmodNoFollow：普通文件与目录照常收紧（.ssh 0700 的防线场景）', async () => {
    const root = await createTempRoot()
    const file = join(root, 'authorized_keys')
    await writeFile(file, 'x', 'utf8')
    const dir = join(root, '.ssh')
    await mkdir(dir)

    await chmodNoFollow(file, 0o600)
    await chmodNoFollow(dir, 0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('chownNoFollow：最终组件是符号链接时拒绝；普通文件照常落属主（自身 uid/gid）', async () => {
    const root = await createTempRoot()
    const real = join(root, 'real.txt')
    await writeFile(real, 'x', 'utf8')
    const link = join(root, 'link.txt')
    await symlink(real, link)

    await expect(chownNoFollow(link, 1234, 1234)).rejects.toThrow()
    // 非 root 环境对自身 uid/gid 的 chown 合法：验证普通路径照常工作。
    const uid = process.getuid?.()
    const gid = process.getgid?.()
    if (uid === undefined || gid === undefined) throw new Error('测试前提失败：拿不到当前进程 uid/gid')
    await expect(chownNoFollow(real, uid, gid)).resolves.toBeUndefined()
  })
})

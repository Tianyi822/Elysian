import { beforeEach, describe, expect, it } from 'vitest'
import {
  compressMockEntry,
  copyMockEntry,
  listMockDirectory,
  measureMockDirectory,
  moveMockEntry,
  renameMockEntry,
  resetFilesData,
} from './filesData'

beforeEach(() => {
  resetFilesData()
})

function names(path: string): string[] {
  return listMockDirectory(path).map((entry) => entry.name)
}

describe('复制', () => {
  it('深拷贝整棵子树，权限与所有者随行', () => {
    const created = copyMockEntry('/home/deploy/.ssh', '/tmp')
    expect(created.name).toBe('.ssh')
    expect(created.mode).toBe('700')
    expect(created.owner).toBe('deploy')
    expect(names('/tmp')).toEqual(['.ssh'])
    expect(names('/tmp/.ssh')).toEqual(['authorized_keys', 'known_hosts'])
  })

  it('目标重名自动加「 副本」后缀', () => {
    copyMockEntry('/bin', '/')
    expect(names('/')).toContain('bin 副本')
    copyMockEntry('/bin', '/')
    expect(names('/')).toContain('bin 副本 2')
  })

  it('源不存在即报错', () => {
    expect(() => copyMockEntry('/no/such', '/tmp')).toThrow('目录不存在')
  })
})

describe('移动', () => {
  it('粘贴后源目录不再持有条目', () => {
    const moved = moveMockEntry('/boot/grub', '/tmp')
    expect(moved.name).toBe('grub')
    expect(names('/boot')).not.toContain('grub')
    expect(names('/tmp')).toContain('grub')
  })

  it('移回原目录报错', () => {
    expect(() => moveMockEntry('/boot/grub', '/boot')).toThrow('目标目录与源目录相同')
  })

  it('把目录移进它自己内部报错', () => {
    expect(() => moveMockEntry('/etc', '/etc/nginx')).toThrow('不能把目录移动到它自己内部')
  })
})

describe('重命名', () => {
  it('改同级唯一名称成功', () => {
    const renamed = renameMockEntry('/etc/hostname', 'hostname.bak')
    expect(renamed.name).toBe('hostname.bak')
    expect(names('/etc')).toContain('hostname.bak')
    expect(names('/etc')).not.toContain('hostname')
  })

  it('与同级重名即报错', () => {
    expect(() => renameMockEntry('/etc/hostname', 'hosts')).toThrow('同名条目已存在')
  })

  it('非法名称报错', () => {
    expect(() => renameMockEntry('/etc/hostname', 'a/b')).toThrow('无效的名称')
    expect(() => renameMockEntry('/etc/hostname', '  ')).toThrow('无效的名称')
  })

  it('名字没变时原样返回，不报重名', () => {
    expect(renameMockEntry('/etc/hosts', 'hosts').name).toBe('hosts')
  })
})

describe('压缩', () => {
  it('同级生成「名称.tar.gz」，大小为内容总和', () => {
    const archive = compressMockEntry('/var/log/auth.log')
    expect(archive.name).toBe('auth.log.tar.gz')
    expect(archive.sizeBytes).toBe(219_530)
    expect(measureMockDirectory('/var/log/nginx')).toBe(8_241_067 + 153_204)

    const dirArchive = compressMockEntry('/var/log/nginx')
    expect(dirArchive.sizeBytes).toBe(8_241_067 + 153_204)
    expect(names('/var/log')).toContain('nginx.tar.gz')
  })

  it('同级已有同名压缩包即报错', () => {
    compressMockEntry('/var/log/auth.log')
    expect(() => compressMockEntry('/var/log/auth.log')).toThrow('同名压缩包已存在')
  })
})

describe('重置演示数据', () => {
  it('把变更类动作产生的条目一并还原', () => {
    copyMockEntry('/bin', '/tmp')
    moveMockEntry('/boot/grub', '/tmp')
    renameMockEntry('/etc/hostname', 'hostname.bak')
    compressMockEntry('/var/log/auth.log')

    resetFilesData()

    expect(names('/tmp')).toEqual([])
    expect(names('/boot')).toContain('grub')
    expect(names('/etc')).toContain('hostname')
    expect(names('/etc')).not.toContain('hostname.bak')
    expect(names('/var/log')).not.toContain('auth.log.tar.gz')
  })
})

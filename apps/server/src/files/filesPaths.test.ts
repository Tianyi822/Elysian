import { describe, expect, it } from 'vitest'
import { InvalidRequestError } from '../shared/errors.ts'
import {
  APP_DIR,
  ELYSIAN_VOLUME_DIR,
  FILE_PATH_MAX_LENGTH,
  SEARCH_PRUNE_DIR_NAMES,
  VIRTUAL_FS_PREFIXES,
  childPathOf,
  forbiddenWritePrefixes,
  isForbiddenWritePath,
  leafNameOf,
  matchPathPrefix,
  normalizeServerFilePath,
  parentDirOf,
  searchExtraPrunePrefixes,
} from './filesPaths'

/*
 * 纯路径判据的行为测试：归一化规则、拒绝项（相对路径、`..`/`.` 段、控制字符、超长）、
 * 写禁区双前缀判定与剪枝清单。全部纯计算，不碰文件系统。homeDir 统一注入 /root，
 * 锚定容器内形态。 */

const HOME = '/root'

describe('normalizeServerFilePath', () => {
  it('压掉连续斜杠与尾斜杠；根目录归一化为自身', () => {
    expect(normalizeServerFilePath('/')).toBe('/')
    expect(normalizeServerFilePath('/var//log/')).toBe('/var/log')
    expect(normalizeServerFilePath('/var/log')).toBe('/var/log')
  })

  it('拒绝相对路径与空串', () => {
    for (const input of ['', 'var/log', './var', 'a']) {
      expect(() => normalizeServerFilePath(input)).toThrow(InvalidRequestError)
      expect(() => normalizeServerFilePath(input)).toThrow(`无效的文件路径：${input}`)
    }
  })

  it('拒绝 `..` 段与 `.` 段（不宽松压掉，判据层直接拒绝）', () => {
    expect(() => normalizeServerFilePath('/a/../b')).toThrow('无效的文件路径：/a/../b')
    expect(() => normalizeServerFilePath('/var/./log')).toThrow('无效的文件路径：/var/./log')
    expect(() => normalizeServerFilePath('/a/b/..')).toThrow('无效的文件路径：/a/b/..')
  })

  it('拒绝 NUL 与全部 C0/C1 控制字符（含换行、制表、DEL）', () => {
    for (const input of ['/a\u0000b', '/a\nb', '/a\tb', '/a\u007Fb', '/a\u0085b', '/a\u009Fb']) {
      expect(() => normalizeServerFilePath(input)).toThrow('无效的文件路径：')
    }
  })

  it('归一化后超过 PATH_MAX 拒绝；恰好等于上限放行', () => {
    const long = `/${'a'.repeat(FILE_PATH_MAX_LENGTH)}`
    expect(() => normalizeServerFilePath(long)).toThrow('无效的文件路径：')
    expect(normalizeServerFilePath(`/${'a'.repeat(FILE_PATH_MAX_LENGTH - 1)}`)).toBe(
      `/${'a'.repeat(FILE_PATH_MAX_LENGTH - 1)}`,
    )
  })
})

describe('路径拼装原语', () => {
  it('childPathOf 在根目录下不产生双斜杠', () => {
    expect(childPathOf('/', 'etc')).toBe('/etc')
    expect(childPathOf('/etc', 'nginx')).toBe('/etc/nginx')
  })

  it('parentDirOf 与 leafNameOf：一级条目的父目录是根', () => {
    expect(parentDirOf('/etc')).toBe('/')
    expect(parentDirOf('/etc/nginx')).toBe('/etc')
    expect(leafNameOf('/etc/nginx/nginx.conf')).toBe('nginx.conf')
    expect(leafNameOf('/etc')).toBe('etc')
  })
})

describe('matchPathPrefix', () => {
  it('等于前缀或落其下才命中；近似前缀字符串不命中', () => {
    expect(matchPathPrefix('/root/.Elysian', ['/root/.Elysian'])).toBe('/root/.Elysian')
    expect(matchPathPrefix('/root/.Elysian/data/x', ['/root/.Elysian'])).toBe('/root/.Elysian')
    expect(matchPathPrefix('/root/.Elysian2', ['/root/.Elysian'])).toBeNull()
    expect(matchPathPrefix('/application', ['/app'])).toBeNull()
    expect(matchPathPrefix('/app', ['/app'])).toBe('/app')
  })
})

describe('写禁区判定', () => {
  it('清单同时收录面板资产字符串名与卷挂真身两侧', () => {
    const prefixes = forbiddenWritePrefixes(HOME)
    expect(prefixes).toContain('/root/.Elysian')
    expect(prefixes).toContain(ELYSIAN_VOLUME_DIR)
    expect(prefixes).toContain('/root/.ssh')
    expect(prefixes).toContain('/root/.bun')
    expect(prefixes).toContain(APP_DIR)
    expect(prefixes).toContain('/proc')
    expect(prefixes).toContain('/sys')
    expect(prefixes).toContain('/dev')
  })

  it('命中与不命中的边界', () => {
    expect(isForbiddenWritePath('/root/.Elysian', HOME)).toBe(true)
    expect(isForbiddenWritePath('/root/.Elysian/data/metrics.sqlite', HOME)).toBe(true)
    expect(isForbiddenWritePath('/var/lib/elysian/data', HOME)).toBe(true)
    expect(isForbiddenWritePath('/root/.ssh/authorized_keys', HOME)).toBe(true)
    expect(isForbiddenWritePath('/root/.bun', HOME)).toBe(true)
    expect(isForbiddenWritePath('/app/src/index.ts', HOME)).toBe(true)
    expect(isForbiddenWritePath('/root/.Elysian2', HOME)).toBe(false)
    expect(isForbiddenWritePath('/application', HOME)).toBe(false)
    expect(isForbiddenWritePath('/etc/nginx/nginx.conf', HOME)).toBe(false)
    expect(isForbiddenWritePath('/var/log', HOME)).toBe(false)
  })
})

describe('遍历剪枝清单', () => {
  it('虚拟 FS 前缀、node_modules 段与工具缓存前缀各就各位', () => {
    expect([...VIRTUAL_FS_PREFIXES]).toEqual(['/proc', '/sys', '/dev'])
    expect(SEARCH_PRUNE_DIR_NAMES).toContain('node_modules')
    expect(searchExtraPrunePrefixes(HOME)).toEqual(['/root/.bun'])
  })
})

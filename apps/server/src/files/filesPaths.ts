import { join } from 'node:path'
import { invalidRequest } from '../shared/errors.ts'

/*
 * 文件管理的纯路径判据：归一化、控制字符与穿越段拒绝、写禁区清单与前缀匹配。
 * 全部动作入口先过这里的判据，归一化结果才进文件系统访问，原始入参只进错误文案
 * ——绕过界面直发请求（手改 URL 的 `.` 段、相对路径、控制字符）也穿不透。
 * 只做纯计算，不碰文件系统；realpath 复核由服务层组合本模块的前缀判定完成。
 */

/** 归一化后路径长度上限：对齐 PATH_MAX（4096）。 */
export const FILE_PATH_MAX_LENGTH = 4096

/** 内核接口与设备节点：读遍历整树剪枝，写操作一律拒绝。 */
export const VIRTUAL_FS_PREFIXES = ['/proc', '/sys', '/dev'] as const

/** compose 持久卷的真身挂载点：/root/.Elysian 是指向这里的符号链接，两侧都得守。 */
export const ELYSIAN_VOLUME_DIR = '/var/lib/elysian'

/** 容器内面板自身代码与运行位置（Dockerfile 的 WORKDIR、绑定挂载与卷都在此前缀下）。 */
export const APP_DIR = '/app'

/** NUL 与全部 C0/C1 控制字符（含换行、制表、DEL 与 U+0080-U+009F）：路径里一律拒绝。 */
const UNSAFE_PATH_CHARS = /[\u0000-\u001F\u007F-\u009F]/

/**
 * 归一化并校验服务端路径：必须以 `/` 开头；逐段检查，`..` 段与 `.` 段一律拒绝；
 * 空段（连续斜杠与尾斜杠）压掉；整串不得含 NUL 与控制字符；归一化后 ≤ 4096。
 * 拒绝时抛 400（`无效的文件路径：<原样入参>`）。`/` 归一化为自身。
 */
export function normalizeServerFilePath(input: string): string {
  const reject = (): never => {
    throw invalidRequest(`无效的文件路径：${input}`)
  }
  if (!input.startsWith('/')) reject()
  if (UNSAFE_PATH_CHARS.test(input)) reject()
  const segments = input.split('/').filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') reject()
  }
  const normalized = segments.length === 0 ? '/' : `/${segments.join('/')}`
  if (normalized.length > FILE_PATH_MAX_LENGTH) reject()
  return normalized
}

/** 拼子路径：根目录下不带双斜杠（`/ + name`），其余直接拼接。name 由调用方保证不含 `/`。 */
export function childPathOf(dirPath: string, name: string): string {
  return dirPath === '/' ? `/${name}` : `${dirPath}/${name}`
}

/** 父目录路径：根目录与一级条目的父目录都是 `/`。调用方须先保证路径已归一化且非根。 */
export function parentDirOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  segments.pop()
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

/** 叶名：路径最后一段。调用方须先保证路径已归一化且非根。 */
export function leafNameOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

/**
 * 前缀匹配：路径等于前缀本身、或落在其下（前缀 + `/`）才算命中——`/root/.Elysian2`
 * 不落在 `/root/.Elysian` 下。返回命中的前缀，未命中返回 null。
 */
export function matchPathPrefix(path: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return prefix
  }
  return null
}

/**
 * 写禁区清单：对归一化路径与 realpath 结果分别做前缀匹配用。`/root` 前缀经注入的
 * homeDir 解析（真实接线传 os.homedir()，值对齐 shared/elysianPaths 的 ELYSIAN_HOME），
 * 不硬编码。同时收录面板资产的字符串名与卷挂真身两侧——只收一侧时符号链接另一侧
 * 的直写会绕过保护。
 */
export function forbiddenWritePrefixes(homeDir: string): readonly string[] {
  return [
    ...VIRTUAL_FS_PREFIXES,
    join(homeDir, '.Elysian'),
    ELYSIAN_VOLUME_DIR,
    join(homeDir, '.ssh'),
    join(homeDir, '.bun'),
    APP_DIR,
  ]
}

/** 归一化路径是否落写禁区（纯字符串判定；realpath 复核由服务层再调一次本函数）。 */
export function isForbiddenWritePath(path: string, homeDir: string): boolean {
  return matchPathPrefix(path, forbiddenWritePrefixes(homeDir)) !== null
}

/** search 专属的额外剪枝前缀：Bun 运行时与安装缓存，不是运维搜索的对象。 */
export function searchExtraPrunePrefixes(homeDir: string): readonly string[] {
  return [join(homeDir, '.bun')]
}

/** search 专属的额外剪枝段名：任何位置的 `node_modules` 目录整树跳过，预算留给系统文件。 */
export const SEARCH_PRUNE_DIR_NAMES: readonly string[] = ['node_modules']

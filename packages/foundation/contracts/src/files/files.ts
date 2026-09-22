/*
 * 文件域类型与词典。文件管理页呈现的是一台主机的目录内容：
 * 读取是唯一动作，上传、下载、删除与重命名都属于系统级变更，
 * 由未来接入的执行层筛选与执行，这里的类型只描述界面需要呈现的事实。
 */

/** 条目种类：目录或文件。符号链接按其指向呈现，不单列一类。 */
export type FileKind = 'directory' | 'file'

export const FILE_KINDS = ['directory', 'file'] as const satisfies readonly FileKind[]

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  directory: '文件夹',
  file: '文件',
}

/** 目录里的一个直接子项，字段口径对齐 stat：名称、种类、权限、所有者、大小与最后修改时间。 */
export type FileEntry = {
  name: string
  kind: FileKind
  /** 权限位，三位八进制（如 '755'），不含文件类型前缀。 */
  mode: string
  /** 所有者的系统账号名。 */
  owner: string
  /** 文件大小（字节）；目录没有大小，值为 undefined。 */
  sizeBytes?: number
  /** 最后修改时间（ISO 8601，带时区）。 */
  modifiedAt: string
}

/** 文件名长度上限，沿用常见文件系统的 255 字节约束。 */
export const FILE_NAME_MAX_LENGTH = 255

/** 文件名里一律拒绝的字符：NUL 与全部 C0/C1 控制字符（含换行、制表、DEL 与 U+0080-U+009F）。 */
const UNSAFE_FILE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F]/

/**
 * 新条目名称判据：去首尾空白后非空、不含斜杠与控制字符、不是 `.` 或 `..`。
 * 控制字符在判据层拦下：这类名字一旦落盘，按路径判据（同样拒绝控制字符）在面板内不可再操作。
 * 重命名与粘贴前先过这一关，重名与否由数据层判定。
 */
export function isValidFileName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > FILE_NAME_MAX_LENGTH) return false
  if (trimmed === '.' || trimmed === '..') return false
  if (UNSAFE_FILE_NAME_CHARS.test(trimmed)) return false
  return !trimmed.includes('/')
}

/*
 * 权限：三位八进制对应三类人各三项动作，与 chmod 的取值一致。
 * 这里只做取值与换算，setuid/sticky 位与 ACL 不在本期范围内。
 */

/** 权限的三类人，顺序对应三位八进制的第 1、2、3 位。 */
export type FilePermissionClass = 'owner' | 'group' | 'public'

export const FILE_PERMISSION_CLASSES = [
  'owner',
  'group',
  'public',
] as const satisfies readonly FilePermissionClass[]

export const FILE_PERMISSION_CLASS_LABELS: Record<FilePermissionClass, string> = {
  owner: '所有者',
  group: '用户组',
  public: '公共',
}

/** 每类人可授予的三项动作，取值对应八进制的 4、2、1。 */
export type FilePermissionAction = 'read' | 'write' | 'execute'

export const FILE_PERMISSION_ACTIONS = [
  'read',
  'write',
  'execute',
] as const satisfies readonly FilePermissionAction[]

export const FILE_PERMISSION_ACTION_LABELS: Record<FilePermissionAction, string> = {
  read: '读取',
  write: '写入',
  execute: '执行',
}

/** 三类人各自的三项开关，权限表单的直接状态。 */
export type FilePermission = Record<FilePermissionClass, Record<FilePermissionAction, boolean>>

/** 每类人的位权重，与八进制逐位相加即可。 */
const FILE_PERMISSION_WEIGHTS: Record<FilePermissionAction, number> = {
  read: 4,
  write: 2,
  execute: 1,
}

/** 三位八进制权限位判据（'000' 至 '777'）。 */
export function isValidFileMode(mode: string): boolean {
  return /^[0-7]{3}$/.test(mode)
}

/*
 * 文件搜索：名称与所在路径两处参与匹配，比对口径与安全区搜索一致
 * ——去掉全部空白并统一小写后做子串包含，大小写与多空格都照常命中。
 */

/** 搜索归一化：去全部空白、统一小写。 */
export function normalizeFileSearch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** 名称或所在路径任一命中即命中；空关键词视为命中，是否发起搜索由调用方决定。 */
export function matchesFilePath(keyword: string, name: string, path: string): boolean {
  const needle = normalizeFileSearch(keyword)
  if (!needle) return true
  return [name, path].some((field) => normalizeFileSearch(field).includes(needle))
}

/** 一条搜索结果：条目本身的全量字段外加它在树中的绝对路径。 */
export type FileSearchResult = FileEntry & {
  /** 条目的绝对路径（如 /var/log/nginx/access.log）。 */
  path: string
}

/** 权限开关转三位八进制：按类顺序取位，缺省按未授予处理。 */
export function permissionToMode(permission: FilePermission): string {
  return FILE_PERMISSION_CLASSES.map((permissionClass) => {
    const actions = permission[permissionClass]
    return FILE_PERMISSION_ACTIONS.reduce(
      (digit, action) => (actions[action] ? digit + FILE_PERMISSION_WEIGHTS[action] : digit),
      0,
    )
  }).join('')
}

/** 三位八进制转权限开关；模式非法时按全不授予返回，界面先前的判据会挡在前面。 */
export function modeToPermission(mode: string): FilePermission {
  const digits = isValidFileMode(mode) ? mode.split('').map(Number) : [0, 0, 0]
  return Object.fromEntries(
    FILE_PERMISSION_CLASSES.map((permissionClass, index) => {
      const digit = digits[index] ?? 0
      return [
        permissionClass,
        Object.fromEntries(
          FILE_PERMISSION_ACTIONS.map((action) => [
            action,
            (digit & FILE_PERMISSION_WEIGHTS[action]) !== 0,
          ]),
        ),
      ]
    }),
  ) as FilePermission
}

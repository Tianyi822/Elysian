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

/**
 * 新条目名称判据：去首尾空白后非空、不含斜杠、不是 `.` 或 `..`。
 * 重命名与粘贴前先过这一关，重名与否由数据层判定。
 */
export function isValidFileName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > FILE_NAME_MAX_LENGTH) return false
  if (trimmed === '.' || trimmed === '..') return false
  return !trimmed.includes('/')
}

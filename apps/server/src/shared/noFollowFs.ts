import { constants as fsConstants } from 'node:fs'
import { lstat, open, writeFile } from 'node:fs/promises'

/*
 * 不跟随符号链接的文件写入与权限原语：面板以 root 写系统文件与账号主目录，
 * 路径最终组件被预置符号链接（如 ~/.ssh → /etc）时，普通 writeFile/chmod/chown
 * 会跟随链接把内容与权限作用到链接目标上，等于把 root 权限借给低权账号。
 * 全部原语以 O_NOFOLLOW 作用于路径本身：最终组件是符号链接即失败（ELOOP），
 * 检查与写入之间被换链的竞态同样封死；中间组件（如 /root/.Elysian 指向持久卷）
 * 不受影响——O_NOFOLLOW 只作用于最后一段。
 */

/** 窄化的 lstat 判定：只暴露「最终组件是否符号链接」，给写入前的防线检查用。 */
export async function isSymbolicLink(path: string): Promise<boolean> {
  return (await lstat(path)).isSymbolicLink()
}

/** 写文件且不跟随最终组件的符号链接：链接占位即失败，绝不写穿到链接目标。 */
export function writeTextNoFollow(path: string, content: string): Promise<void> {
  return writeFile(path, content, {
    encoding: 'utf8',
    flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
  })
}

/** 以句柄收紧权限且不跟随最终组件的符号链接：权限绝不落到链接目标上。 */
export async function chmodNoFollow(path: string, mode: number): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    await handle.chmod(mode)
  } finally {
    await handle.close()
  }
}

/** 以句柄落属主且不跟随最终组件的符号链接：属主绝不落到链接目标上。 */
export async function chownNoFollow(path: string, uid: number, gid: number): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    await handle.chown(uid, gid)
  } finally {
    await handle.close()
  }
}

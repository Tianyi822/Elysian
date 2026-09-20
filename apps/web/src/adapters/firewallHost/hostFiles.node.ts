import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/*
 * 规则文件的落盘方式。单独成模块、不依赖 bun:sqlite 与 vite：原子写与内核接口
 * 路径判定是这个适配层最容易写错、又最难在容器外复现的两处，放在这里就能由
 * Vitest 直接覆盖（hostFiles.node.test.ts），而不是躲在只有 bun 才能加载的文件里。
 */

/**
 * 原子写文件：先写同目录的隐藏临时文件，再 rename 替换（同目录 rename 在
 * POSIX 上是原子操作）。半截写入会留下损坏的 before.rules，ufw 装载失败后
 * 停在不设防的停用态，因此规则文件的落盘绝不直接 writeFile 到目标路径。
 */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.elysian-tmp-${randomUUID()}`)
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 内核接口路径（procfs/sysfs）：解封 IP 写 /proc/net/xt_recent/<名单>、
 * 开启内核转发写 /proc/sys/net/ipv4/ip_forward，都落在这些目录下。它们是内核
 * 暴露的节点，目录本身不可写、rename 也不被支持，「同目录临时文件 + rename」
 * 必然失败，只有直接 writeFile 才能落到内核接口上。
 */
export function isKernelInterfacePath(path: string): boolean {
  return path.startsWith('/proc/') || path.startsWith('/sys/')
}

/** 按目标选择落盘方式：内核接口直接写目标，普通文件（规则文件等）原子替换。 */
export async function writeHostFile(path: string, content: string): Promise<void> {
  if (isKernelInterfacePath(path)) {
    await writeFile(path, content, 'utf8')
    return
  }
  await atomicWriteText(path, content)
}

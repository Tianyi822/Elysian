import type { FileEntry } from '@elysian/contracts'

/*
 * 文件列表的视图纯函数：排序与大小格式化。顺序是界面的决定——
 * adapter 不承诺任何顺序（真实 readdir 也不承诺），在这里排好再进表格。
 */

/** 文件夹在前、文件在后，各自按名称升序；返回新数组，不动传入的列表。 */
export function orderFileEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** 大小按 1024 进位，KB 起保留一位小数；目录没有大小，由调用位显示「—」。 */
export function formatEntrySize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  const kb = sizeBytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** 常驻内存来源；statm 是近似读数，unavailable 表示无法读取实际常驻内存。 */
export type PlatformMemorySource = 'smaps-rollup' | 'smaps' | 'statm' | 'unavailable'

/**
 * Go 后端单进程内存。所有 Mb 字段的单位均为 MiB（1,048,576 字节），保留既有字段名。
 * RSS 与 Go 内存是不同口径，不能相加；堆预留含已归还系统的地址空间。
 */
export type PlatformMemorySample = {
  rssMb: number | null
  rssSource: PlatformMemorySource
  /** 后端运行环境的系统总内存；Linux 容器内取宿主内核 MemTotal，不表示容器限额。 */
  systemTotalMb: number | null
  sampledAt: string
  /** 已分配堆对象，含尚未回收的垃圾。 */
  heapUsedMb: number
  /** 堆预留地址空间，包含未触及和已归还系统的页面。 */
  heapTotalMb: number
  /** 已使用堆页中的空位与碎片。 */
  heapUnusedMb: number
  /** 空闲但尚未归还系统、供后续分配复用的堆。 */
  heapRetainedMb: number
  heapReleasedMb: number
  /** Go 管理的栈、GC 元数据等，不含堆预留。 */
  runtimeOtherMb: number
  /** 上次 GC 标记为存活的堆对象，首次 GC 前为 0。 */
  heapLiveMb: number
  gcCount: number
}

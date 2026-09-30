import { constants as fsConstants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { join } from 'node:path'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import { parseLoginLogLine, parseOperationLogLine, parseRuntimeLogLine } from './logRecords.ts'
import { logCategoryDir, type LogShardCategory } from './logsPaths.ts'
import { createLogWriter, type LogWriter } from './logWriter.ts'
import { createLogsService, type LogsService } from './logsService.ts'
import type { LogFileStat } from './logRetention.ts'

/*
 * 平台日志的真实接线：fs 原语、node:zlib 流式 gzip/gunzip、时钟、定时器、读行器。
 * 产出 `{ service }`——**没有 available**：本片只读写 ~/.Elysian 下面板自有的目录，
 * 不执行系统命令、不碰系统文件、不需要 root 能力，因此宿主机本地开发与容器内是同一套实现，
 * 也没有 503 段（后来者不要照着防火墙/SSH/用户/文件四片抄一个 available 出来）。
 *
 * 每次 append 都 open(O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW, 0600) + 写一行 + close：
 * 一行一次 write 系统调用；预先在分片路径放符号链接时写入直接失败，绝不写穿到链接目标
 * （与 shared/noFollowFs 的既有纪律同源；中间组件如 /root/.Elysian → 持久卷不受影响）。
 *
 * 装配本身不碰文件系统：目录创建、巡检定时器都发生在第一次 append 之后。
 */

export type LogsHostDepsOptions = {
  /** 平台日志根：缺省取共享路径出口 ELYSIAN_PATHS.platformLogsDir，测试注入临时根。 */
  platformLogsDir?: string
  /** 时钟注入：缺省真实时钟（测试用假时钟）。 */
  now?: () => Date
}

export type LogsHostDeps = {
  service: LogsService
}

/** 追加一行且不跟随最终组件的符号链接；目录不存在由调用方先 ensureDir。 */
async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.write(line)
  } finally {
    await handle.close()
  }
}

/** recursive + 0700，幂等（已存在不报错）。 */
function ensureDir(dir: string): Promise<void> {
  return mkdir(dir, { recursive: true, mode: 0o700 }).then(() => undefined)
}

/** 幂等删除：不存在即成功。普通文件与符号链接都只摘自身（**不跟随链接**，链接目标不受影响）；
 * 子目录递归删除，递归同样不跟随其中的符号链接。 */
async function removeFile(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * 把 src 压缩成 dest：先写 `dest.tmp` 再 rename（原子发布），并把 src 的 mtime 搬到产物上。
 * **先在 .tmp 上搬 mtime 再 rename**：这样任何时刻发布出去的产物都带着源片的 mtime——
 * rename 之后再 utimes 会留下一个「产物 mtime = 压缩时刻」的崩溃窗口，而保留窗口正是按
 * mtime 算的，撞上那个窗口就等于把窗口从压缩那一刻重新起算。
 * 不删 src：删源由调用方在成功后做（崩溃在 rename 前源片完好，下次巡检重做）。
 */
async function gzipFile(src: string, dest: string): Promise<void> {
  const source = await lstat(src)
  const tmp = `${dest}.tmp`
  // 用句柄开流：O_NOFOLLOW 只作用于最后一段（预先在 .tmp 路径放符号链接时写入直接失败）；
  // 中间组件（如 /root/.Elysian → 持久卷）不受影响。
  const handle = await open(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  )
  // autoClose 默认开启：流结束/销毁时句柄一并关闭，出错也不会泄漏 fd。
  await pipeline(createReadStream(src), createGzip(), handle.createWriteStream())
  await utimes(tmp, source.atime, source.mtime)
  await rename(tmp, dest)
}

/**
 * 逐行读一个文件到 EOF：`.gz` 自动接一层 createGunzip，流与 readline 由本函数关闭。
 * 没有「中途停止」的路径：读侧要的是文件的尾部（最新记录）。文件级错误照常抛出，
 * 由读取器逐文件 try/catch 吸收。
 */
async function readLines(path: string, onLine: (line: string) => void): Promise<void> {
  const source = createReadStream(path)
  const input = path.endsWith('.gz') ? source.pipe(createGunzip()) : source
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) onLine(line)
  } finally {
    reader.close()
    source.destroy()
  }
}

/**
 * 保留与统计口径的列目录：返回类别目录下的**全部条目**（普通文件、符号链接、子目录）——
 * 只有把它们都纳进来，「不允许日志无限增长」才没有开口（子目录可以装下任意多字节，
 * 且完全不进「日志大小」）。读取侧另有 listRegularFiles：那条路仍然只认普通文件。
 *
 * sizeBytes：普通文件与符号链接取自身 lstat 大小（**不跟随链接**）；子目录取内容的递归
 * 字节和（递归同样不跟随符号链接，链接按自身 lstat 大小计）。目录不存在或不可读归一为 []。
 */
function createListEntries(platformLogsDir: string) {
  return async (category: LogShardCategory): Promise<LogFileStat[]> => {
    const dir = logCategoryDir(category, platformLogsDir)
    return listEntriesIn(dir)
  }
}

/** 目录内容的递归字节和：不跟随符号链接（链接按自身 lstat 大小计，不进去）。 */
async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = join(dir, entry.name)
    try {
      const info = await lstat(child)
      if (info.isDirectory()) total += await directorySizeBytes(child)
      else total += info.size
    } catch {
      // 竞态：条目在列出与 lstat 之间消失。
    }
  }
  return total
}

async function listEntriesIn(dir: string): Promise<LogFileStat[]> {
  const listed: LogFileStat[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name)
    try {
      const info = await lstat(path)
      const kind: LogFileStat['kind'] = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'directory'
          : 'symlink'
      listed.push({
        path,
        name,
        sizeBytes: info.isDirectory() ? await directorySizeBytes(path) : info.size,
        mtimeMs: info.mtimeMs,
        kind,
      })
    } catch {
      // 竞态：条目在列出与 lstat 之间消失。
    }
  }
  return listed
}

/** 读取侧的列目录：**只返回 lstat 为普通文件的项**（符号链接与子目录一律跳过，不跟随链接读外部文件）。 */
function createListRegularFiles(platformLogsDir: string) {
  return async (
    category: LogShardCategory,
  ): Promise<{ path: string; name: string; sizeBytes: number }[]> => {
    const dir = logCategoryDir(category, platformLogsDir)
    const listed: { path: string; name: string; sizeBytes: number }[] = []
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, name)
      try {
        const info = await lstat(path)
        if (!info.isFile()) continue
        listed.push({ path, name, sizeBytes: info.size })
      } catch {
        // 竞态：条目在列出与 lstat 之间消失。
      }
    }
    return listed
  }
}

/** 平台日志片的真实装配：产出 `{ service }`（无 available，见文件头）。 */
export function createLogsHostDeps(options: LogsHostDepsOptions = {}): LogsHostDeps {
  const platformLogsDir = options.platformLogsDir ?? ELYSIAN_PATHS.platformLogsDir
  const now = options.now ?? (() => new Date())
  // 前向引用：写入器的巡检回调要调 service，而 service 由写入器构成。
  let service: LogsService | undefined

  const mkWriter = (category: LogShardCategory): LogWriter =>
    createLogWriter(
      {
        platformLogsDir,
        now,
        ensureDir,
        listNames: (dir) => readdir(dir).catch(() => [] as string[]),
        sizeOf: (path) => stat(path).then((info) => info.size, () => null),
        // 采用当日片与判定「活动片还在不在」都走 lstat：符号链接/目录占位一律当作不可写，
        // 绝不顺着链接看到目标、也绝不写穿（见 LogWriterDeps.isRegularFile）。
        isRegularFile: (path) => lstat(path).then((info) => info.isFile(), () => false),
        appendLine,
        // 只上报，不 await：写侧不因巡检变慢而变慢（定时器与锁都在 service 侧）。
        requestSweep: (reason) => {
          void service?.runSweep(category, reason)
        },
      },
      category,
    )

  // 两条列目录口径分开：读取侧只认普通文件（不跟随链接读外部文件），
  // 保留侧要看到目录里的全部条目（否则子目录/链接会落在预算与统计之外）。
  const readerFiles = { listFiles: createListRegularFiles(platformLogsDir), readLines }
  const retention = {
    platformLogsDir,
    now,
    ensureDir,
    listFiles: createListEntries(platformLogsDir),
    gzipFile,
    removeFile,
  }

  service = createLogsService({
    writers: { runtime: mkWriter('runtime'), operation: mkWriter('operation'), login: mkWriter('login') },
    readers: {
      runtime: { ...readerFiles, parseLine: parseRuntimeLogLine },
      operation: { ...readerFiles, parseLine: parseOperationLogLine },
      login: { ...readerFiles, parseLine: parseLoginLogLine },
    },
    retention: { runtime: { ...retention }, operation: { ...retention }, login: { ...retention } },
    now,
    // 只在第一次巡检请求到来时注册（也就是第一次写入之后）：装配期零副作用。
    startTimer: (onTick, intervalMs) => {
      const timer = setInterval(onTick, intervalMs)
      timer.unref()
    },
  })
  return { service }
}

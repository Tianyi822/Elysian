import { createReadStream } from 'node:fs'
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type { LogStore, LogSweepCategory } from './logStore.ts'

/** 仅接受现行分片命名：类别-UTC 时间戳，可选 _2+ 后缀，可选 .gz。 */
const SHARD_FILE_PATTERN =
  /^(runtime|operation|login)-\d{8}T\d{6}Z(?:_[2-9]\d*)?\.jsonl(\.gz)?$/

const CATEGORIES: readonly LogSweepCategory[] = ['runtime', 'operation', 'login']

async function readShardText(path: string): Promise<string> {
  if (!path.endsWith('.gz')) {
    return readFile(path, 'utf8')
  }
  const chunks: Buffer[] = []
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    }),
  )
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 启动时把平台日志目录下的 jsonl / jsonl.gz 分片导入 SQLite。
 * 成功导入的分片 unlink；读失败或 unlink 失败则 console.error 并留下文件。
 */
export async function importPlatformLogs(
  store: LogStore,
  platformLogsDir: string,
): Promise<void> {
  for (const category of CATEGORIES) {
    const dir = join(platformLogsDir, category)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!SHARD_FILE_PATTERN.test(name)) continue
      const fullPath = join(dir, name)
      let text: string
      try {
        text = await readShardText(fullPath)
      } catch (error) {
        console.error(
          `Elysian 日志导入读文件失败（${fullPath}）：${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      const lines = text.split('\n')
      try {
        store.importFile(category, lines)
      } catch (error) {
        console.error(
          `Elysian 日志导入事务失败（${fullPath}）：${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      try {
        await unlink(fullPath)
      } catch (error) {
        console.error(
          `Elysian 日志导入删除分片失败（${fullPath}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}

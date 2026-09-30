import type { LogStore, LogSweepResult } from './logStoreTypes.ts'

const UNAVAILABLE_MESSAGE = '日志数据库不可用'

function emptySweep(failed = 0): LogSweepResult {
  return {
    deletedByAge: 0,
    deletedBySize: 0,
    freedBytes: 0,
    totalBytes: 0,
    trimmedBySize: false,
    failed,
  }
}

/** 打开失败时的回落：写入计 failedWrites，查询抛中文错误。不依赖 bun:sqlite。 */
export function createUnavailableLogStore(): LogStore {
  let failedWrites = 0

  function unavailable(): never {
    throw new Error(UNAVAILABLE_MESSAGE)
  }

  return {
    insertRuntime() {
      failedWrites += 1
    },
    insertLogin() {
      failedWrites += 1
    },
    insertOperation() {
      failedWrites += 1
    },
    importFile: unavailable,
    queryRuntime: unavailable,
    queryLogin: unavailable,
    queryOperation: unavailable,
    clear: unavailable,
    sweep() {
      return emptySweep(1)
    },
    storage(sweep) {
      return {
        totalBytes: 0,
        runtimeBytes: 0,
        operationBytes: 0,
        runtimeRowCount: 0,
        operationRowCount: 0,
        rowCount: 0,
        oldestAt: null,
        lastSweepAt: sweep.lastSweepAt,
        trimmedBySize: sweep.trimmedBySize,
        droppedRecords: 0,
        failedWrites,
      }
    },
    counters() {
      return { droppedRecords: 0, failedWrites }
    },
    close() {},
  }
}

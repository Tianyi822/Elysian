import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import type { FileDownload, FilePermissionInput, FilesAdapter, FileUploadCheck, FileUploadOptions } from '../../contracts/adapters'
import {
  chmodMockEntry,
  checkMockFileUpload,
  compressMockEntry,
  copyMockEntry,
  listMockDirectory,
  measureMockDirectory,
  moveMockEntry,
  renameMockEntry,
  searchMockFiles,
  uploadMockFile,
} from './filesData'

/** 演示目录大小统计的固定耗时；测试想控制节奏时注入自己的 FilesAdapter。 */
const FILES_SIZE_DELAY_MS = 400

export class MockFilesAdapter implements FilesAdapter {
  async prepareDownload(_path: string, signal?: AbortSignal): Promise<FileDownload> {
    signal?.throwIfAborted()
    throw new Error('演示模式没有真实文件内容，请在连接后端的文件页面下载')
  }

  startDownload(_download: FileDownload, onError?: (error: Error) => void): void {
    onError?.(new Error('演示模式没有真实文件内容'))
  }

  async checkUpload(dirPath: string, name: string, sizeBytes: number, signal?: AbortSignal): Promise<FileUploadCheck> {
    signal?.throwIfAborted()
    return checkMockFileUpload(dirPath, name, sizeBytes)
  }

  async uploadFile(dirPath: string, file: File, check: FileUploadCheck, overwrite: boolean, options?: FileUploadOptions): Promise<FileEntry> {
    options?.signal?.throwIfAborted()
    const saved = uploadMockFile(dirPath, file, check, overwrite)
    options?.onProgress?.(100)
    return saved
  }

  async list(dirPath: string): Promise<readonly FileEntry[]> {
    return listMockDirectory(dirPath)
  }

  async size(dirPath: string): Promise<number> {
    // 目录大小统计模拟真实 du 的耗时：给界面的等待状态留一个可见的窗口。
    await new Promise((resolve) => setTimeout(resolve, FILES_SIZE_DELAY_MS))
    return measureMockDirectory(dirPath)
  }

  async copyEntry(srcPath: string, destDirPath: string): Promise<FileEntry> {
    return copyMockEntry(srcPath, destDirPath)
  }

  async moveEntry(srcPath: string, destDirPath: string): Promise<FileEntry> {
    return moveMockEntry(srcPath, destDirPath)
  }

  async renameEntry(path: string, newName: string): Promise<FileEntry> {
    return renameMockEntry(path, newName)
  }

  async compressEntry(path: string): Promise<FileEntry> {
    return compressMockEntry(path)
  }

  async chmod(path: string, input: FilePermissionInput): Promise<void> {
    chmodMockEntry(path, input)
  }

  async search(keyword: string): Promise<readonly FileSearchResult[]> {
    return searchMockFiles(keyword)
  }
}

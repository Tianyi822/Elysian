import { isDevAccountEnabled } from './authConfig.ts'
import { createFileCredentialsStore, type CredentialsStore } from './credentialsStore.ts'
import { changePanelPassword } from './passwordChange.ts'
import { createScryptHasher, type PasswordHasher } from './passwordHasher.ts'

/*
 * 改密 CLI 入口：bun 直跑脚本（非 HTTP 端点——「改密只能在命令行进行」，面板不提供
 * 改密界面端点，也少一个高价值攻击面）。
 *
 * 命令形态：
 * - 裸机部署（server 直跑宿主）：仓库根 `bun run resetpwd`；
 * - compose 环境：`docker compose exec web bun run resetpwd`（凭据文件经
 *   /root/.Elysian 符号链接落在持久卷上，与面板进程看到同一份文件）。
 *
 * 交互全中文，退出码非 0 即失败：
 * 1. 提示输入新密码（至少 8 位）：真 TTY 用 setRawMode 逐字节读、不回显、支持退格、
 *    回车结束、Ctrl-C 中止；非 TTY（管道/脚本）改逐行读并事前提示输入将明文回显。
 * 2. 再次输入新密码，同法读入。
 * 3. 两次明文交给 passwordChange 纯函数校验并写盘。
 * 4. 打印改密结果；ELYSIAN_AUTH_DEV=1 时追加开发固定账号不受影响的说明。
 *
 * 落点纪律：校验与写盘逻辑全在 passwordChange.ts；本文件只做 stdin 交互与打印。
 * 顶层执行段包在 `if (import.meta.main)` 门禁内——bun 直跑才交互，vitest 为测纯逻辑
 * import 本文件时不触发任何读写。
 */

/** CLI 的 IO 出口：测试注入 fake（不真起交互）；缺省实现绑 process.stdin/stdout。 */
export type ResetPasswordIo = {
  /** 是否交互终端（process.stdin.isTTY === true）。 */
  isTTY(): boolean
  /** 交互式无回显读一行：真实现 setRawMode 逐字节、退格可改、Ctrl-C 抛「已取消改密」。 */
  readHidden(prompt: string): Promise<string>
  /** 明文读一行（非 TTY：管道/脚本）。 */
  readLine(prompt: string): Promise<string>
  print(text: string): void
}

/** TTY 无回显读一行：逐字节缓冲，回车结束；退格（0x7f/0x08）弹出一个字节；Ctrl-C（0x03）中止。 */
function readHiddenFromTty(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?(mode: boolean): void }
  stdin.setRawMode?.(true)
  stdin.resume()
  return new Promise<string>((resolve, reject) => {
    const bytes: number[] = []
    const cleanup = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('已取消改密'))
          return
        }
        if (byte === 0x0d || byte === 0x0a) {
          process.stdout.write('\n')
          cleanup()
          resolve(Buffer.from(bytes).toString('utf8'))
          return
        }
        if (byte === 0x7f || byte === 0x08) {
          bytes.pop()
          continue
        }
        bytes.push(byte)
      }
    }
    stdin.on('data', onData)
  })
}

/** 非 TTY 逐行读的跨调用缓冲：一次 data 事件可能带多行（管道一次性写入），
 * 未消费的余量必须留给下一次 readLine，否则第二行被静默丢弃。 */
let stdinLeftover = ''

/** 非 TTY 逐行读：读到换行即止（末尾 \r\n 归一）；EOF 时把剩余内容当最后一行，
 * 一无所有则抛中文错误（脚本场景下快速失败而不是挂死）。 */
function readLineFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  const existing = stdinLeftover.indexOf('\n')
  if (existing >= 0) {
    const line = stdinLeftover.slice(0, existing).replace(/\r$/, '')
    stdinLeftover = stdinLeftover.slice(existing + 1)
    return Promise.resolve(line)
  }
  process.stdin.resume()
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.pause()
    }
    const onData = (chunk: Buffer) => {
      stdinLeftover += chunk.toString('utf8')
      const newline = stdinLeftover.indexOf('\n')
      if (newline >= 0) {
        cleanup()
        const line = stdinLeftover.slice(0, newline).replace(/\r$/, '')
        stdinLeftover = stdinLeftover.slice(newline + 1)
        resolve(line)
      }
    }
    const onEnd = () => {
      cleanup()
      if (stdinLeftover === '') {
        reject(new Error('输入已结束，未读到密码'))
        return
      }
      const line = stdinLeftover.replace(/\r$/, '')
      stdinLeftover = ''
      resolve(line)
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
  })
}

/** 缺省 IO：绑真实 stdin/stdout（bun 直跑时使用）。 */
export function defaultResetPasswordIo(): ResetPasswordIo {
  return {
    isTTY: () => process.stdin.isTTY === true,
    readHidden: (prompt) => readHiddenFromTty(prompt),
    readLine: (prompt) => readLineFromStdin(prompt),
    print: (text) => console.log(text),
  }
}

/** CLI 主流程（IO 与改密依赖全部经注入出口）：读两次密码 → 纯函数改密 → 打印结果。 */
export async function runResetPasswordCli(
  io: ResetPasswordIo,
  deps: { credentials: CredentialsStore; hasher: PasswordHasher } = {
    credentials: createFileCredentialsStore(),
    hasher: createScryptHasher(),
  },
): Promise<void> {
  const tty = io.isTTY()
  const read = tty ? io.readHidden : io.readLine
  if (!tty) io.print('当前不是交互终端，输入将明文回显')
  const first = await read('请输入新密码（至少 8 位）：')
  const second = await read('请再次输入新密码：')
  await changePanelPassword(deps, first, second)
  io.print('面板密码已修改；全部现有登录会话已失效，请重新登录。')
  if (isDevAccountEnabled()) io.print('开发固定账号不受影响（仅开发环境可用）。')
}

if (import.meta.main) {
  runResetPasswordCli(defaultResetPasswordIo()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

/**
 * chpasswd 子进程的基础设施原语，供 users 与 ssh 域共用。
 * 凭据只走 stdin，密码不进命令行参数。
 */

/** chpasswd 管道读端的最小形状：数据经 data 事件送达（真实流是 Readable，fake 是 EventEmitter）。 */
type ChpasswdPipeReader = {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
}

/** chpasswd 管道写端（stdin）的最小形状：可写可关，写失败（EPIPE 等）经 error 事件送达。 */
type ChpasswdStdinPipe = {
  on(event: 'error', listener: (error: Error) => void): unknown
  write(chunk: string): unknown
  end(): unknown
}

/**
 * chpasswd 子进程的最小形状：三路管道与 error/close 生命周期。stdio 全 pipe 时流端
 * 非空，类型上仍允许 null（对应 stdio 配成 inherit 等情形），建立失败走中文 reject。
 */
export type ChpasswdChildLike = {
  stdin: ChpasswdStdinPipe | null
  stdout: ChpasswdPipeReader | null
  stderr: ChpasswdPipeReader | null
  on(event: 'error' | 'close', listener: (arg: Error | number | null) => void): unknown
}

/** spawn 的最小形状：runChpasswdViaStdin 注入 fake spawn 用，测试不 spawn 任何真实进程。 */
export type SpawnChpasswdLike = (command: string, args: readonly string[]) => ChpasswdChildLike

/**
 * chpasswd 凭据只走 stdin：spawn 后把 `账号:密码` 写进标准输入，密码不进命令行。
 * stdin 挂 error 监听：chpasswd 在读 stdin 前退出时，后续写入以 EPIPE 报错——
 * 不接住这个流错误，它会成为未处理异常直接打崩 server 进程。
 */
export function runChpasswdViaStdin(spawnChpasswd: SpawnChpasswdLike, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnChpasswd('chpasswd', [])
    let stderr = ''
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve('')
      else reject(new Error(stderr.trim() || `chpasswd 退出码 ${code ?? 'unknown'}`))
    })
    const { stdin, stdout, stderr: stderrPipe } = child
    if (stdin === null || stdout === null || stderrPipe === null) {
      reject(new Error('chpasswd 子进程的标准管道未建立'))
      return
    }
    stdout.on('data', () => undefined)
    stderrPipe.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    stdin.on('error', reject)
    stdin.write(input)
    stdin.end()
  })
}

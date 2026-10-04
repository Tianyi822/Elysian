/**
 * 容器应用工作区：随容器一起上传的配置文件（compose.yml、.env、各类 config）的
 * 存放、内容读写与 compose 引用路径自检。
 *
 * 面板只落盘并回显真实路径，不执行 docker compose、不做 docker build（ADR-0020）。
 * 实体目录在 mountRoot 下，因为只有那一侧的路径在宿主、面板与 Docker daemon 三方一致。
 */

export type ContainerAppFile = {
  /** 相对工作区根的路径，始终用正斜杠。 */
  path: string
  size: number
  modifiedAt: string
  /** 是否可按文本编辑：UTF-8 且未超编辑体积上限。 */
  text: boolean
}

export type ContainerApp = {
  /** 工作区标识，同时是目录名；服务端与界面同规则校验。 */
  slug: string
  displayName: string
  createdAt: string
  /** 绝对路径，可直接抄进 compose。 */
  directory: string
  /** 清单由服务端当场扫目录得出，界面不缓存第二份事实。 */
  files: readonly ContainerAppFile[]
}

export type ComposeReferenceKind = 'volume' | 'env_file'

export type ComposeReference = {
  /** compose 里出现的原始写法。 */
  raw: string
  kind: ComposeReferenceKind
  line: number
  /** 相对工作区根的路径。 */
  path: string
  /** 该路径所属的工作区绝对根，便于拼出完整可抄的路径。 */
  scope: string
  exists: boolean
}

export type ComposeCheckResult = {
  composePath: string
  composeDir: string
  references: readonly ComposeReference[]
  /** 扫描器判定不了的行，原样列出，不静默跳过。 */
  undetermined: readonly string[]
  /** 判定范围说明：自检是保守行扫描，界面必须把它显示出来。 */
  coverage: string
}

export const COMPOSE_REFERENCE_KIND_LABELS: Record<ComposeReferenceKind, string> = {
  volume: '挂载路径',
  env_file: '环境变量文件',
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9一-龥][A-Za-z0-9一-龥 ._-]{0,79}$/

/** 工作区标识校验：与服务端 containerapps.ValidateSlug 同一规则与同一句话。 */
export function validateContainerAppSlug(slug: string): string | null {
  if (!slug) return '工作区名称不能为空'
  if (!SLUG_PATTERN.test(slug)) return '工作区名称只能由小写字母、数字、下划线和连字符组成，且以字母或数字开头'
  return null
}

/** 展示名校验：与服务端同一规则（首字符不得是分隔符，长度不超过 80）。留空由服务端回填标识。 */
export function validateContainerAppDisplayName(displayName: string): string | null {
  if (!displayName) return null
  if ([...displayName].length > 80) return '工作区展示名不得超过 80 个字符'
  if (!DISPLAY_NAME_PATTERN.test(displayName)) return '工作区展示名包含不允许的字符'
  return null
}

/**
 * 工作区里某个文件的绝对路径：回显与复制都用它，不靠界面自己拼。
 * 只用到 path，所以接受任何带 path 的对象——确认弹窗里那句待删路径也是同一个出口。
 */
export function containerAppFilePath(
  app: ContainerApp,
  file: Pick<ContainerAppFile, 'path'>,
): string {
  return `${app.directory.replace(/\/+$/, '')}/${file.path}`
}

/**
 * 相对子路径校验：拒绝绝对路径、反斜杠、空段、`.` 与 `..` 段、超限层数与长度。
 * `.`/`..` 逐段拒绝而不是折叠消除——折叠会把 `a/../b` 变成 `b`，让调用方以为
 * 原意被保留。服务端 containerapps.NormalizeRelative 与本函数同规则同措辞。
 */
export function normalizeWorkspaceRelativePath(rel: string): string {
  if (!rel) throw new Error('文件路径不能为空')
  if (rel.length > 512) throw new Error('文件路径过长')
  if (rel.startsWith('/')) throw new Error('文件路径必须是相对路径')
  if (rel.includes('\\')) throw new Error('文件路径不允许反斜杠')
  if (rel.includes('\u0000')) throw new Error('文件路径包含非法字符')
  if (rel.endsWith('/')) throw new Error('文件路径必须指向文件本身')
  const segments = rel.split('/')
  if (segments.length > 8) throw new Error('文件路径层级过深')
  for (const segment of segments) {
    if (!segment) throw new Error('文件路径包含空路径段')
    if (segment === '.' || segment === '..') throw new Error('文件路径不允许 . 与 .. 段')
  }
  return segments.join('/')
}

/**
 * compose 引用路径自检（保守行扫描）。
 *
 * 没有 YAML 解析器可用：Go 侧 go.mod 的固定选型不引入其它框架，web 侧同样没有依赖，
 * 所以只判 volumes 短语法/长语法 source 与 env_file 里 `./` 开头的相对引用。
 * 判定不了的行一律进 undetermined 原样列出——静默漏报比不检查更坑。
 * 服务端 containerapps.CheckCompose 与本函数同规则；两侧用同一条 fixture 测试锚定。
 */
export function checkComposeReferences(input: {
  composePath: string
  composeDir: string
  content: string
  /** 由调用方提供存在性判定：真实侧查磁盘，演示侧查内存文件表。 */
  hasFile: (relativeToComposeDir: string) => boolean
}): ComposeCheckResult {
  const references: ComposeReference[] = []
  const undetermined: string[] = []
  let mode: 'volumes' | 'env_file' | 'build' | '' = ''
  let modeIndent = -1
  /** compose 里的键名（volumes）与引用类型名（volume）不同形，这里做一次映射。 */
  const kindOf = (key: 'volumes' | 'env_file'): ComposeReferenceKind => (key === 'volumes' ? 'volume' : 'env_file')

  const inspect = (kind: ComposeReferenceKind, rawValue: string, line: number) => {
    let value = stripInlineComment(rawValue).trim().replace(/^["']|["']$/g, '')
    if (!value) return
    if (ambiguousReference(value)) {
      undetermined.push(`第 ${line} 行：${value}`)
      return
    }
    let source = value
    if (kind === 'volume') {
      const parts = value.split(':')
      if (parts.length >= 2) source = parts[0]!
    }
    if (source === '.' || source === '..' || source.startsWith('../') || source.startsWith('/')) {
      undetermined.push(`第 ${line} 行：${source}（指向工作区之外或上级路径，面板不判定）`)
      return
    }
    // 既不是 ./ 开头也不是绝对路径：那是命名卷，不是宿主文件引用。
    if (!source.startsWith('./')) return
    const relative = source.slice(2)
    references.push({
      raw: value,
      kind,
      line,
      path: relative,
      scope: input.composeDir,
      exists: input.hasFile(relative),
    })
  }

  input.content.split('\n').forEach((rawLine, index) => {
    const lineNumber = index + 1
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) return
    const indent = rawLine.length - rawLine.trimStart().length
    if (modeIndent >= 0 && indent <= modeIndent) {
      mode = ''
      modeIndent = -1
    }
    if (!line.startsWith('-')) {
      const colon = line.indexOf(':')
      if (colon <= 0) return
      const key = line.slice(0, colon).trim()
      if (/["'#]/.test(key) || key.startsWith('-')) return
      const value = line.slice(colon + 1).trim()
      if (key === 'volumes' || key === 'env_file') {
        mode = key
        modeIndent = indent
        if (value) inspect(kindOf(key), value, lineNumber)
        return
      }
      if (key === 'build') {
        mode = 'build'
        modeIndent = indent
        undetermined.push(`第 ${lineNumber} 行：${line}（本轮不做构建，build 段不判定）`)
        return
      }
      if (key === 'source' && mode === 'volumes') inspect('volume', value, lineNumber)
      return
    }
    if (mode === 'volumes' || mode === 'env_file') {
      inspect(kindOf(mode), line.replace(/^-\s*/, ''), lineNumber)
    }
  })

  return {
    composePath: input.composePath,
    composeDir: input.composeDir,
    references,
    undetermined,
    coverage: COMPOSE_CHECK_COVERAGE,
  }
}

/** 判定范围说明；界面必须把它显示出来，不能让人误以为是全量解析。 */
export const COMPOSE_CHECK_COVERAGE =
  '只判定 volumes 短语法与长语法 source、以及 env_file 引用的路径是否存在；' +
  '含变量替换、锚点引用、flow 风格与 build 段的行列入未能判定清单，请人工核对'

function ambiguousReference(value: string): boolean {
  return (
    value.includes('$') ||
    value.startsWith('*') ||
    value.includes('&') ||
    /[{}[\]]/.test(value) ||
    value.startsWith('!') ||
    value.startsWith('?')
  )
}

function stripInlineComment(value: string): string {
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || value[index - 1] === ' ')) return value.slice(0, index).trim()
  }
  return value
}

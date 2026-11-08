// 真实工具集成测试：只使用本地 npm / Go 代理，隔离容器运行时无需出网。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'elysian-build-cache-test-'))
const script = resolve('scripts/build-release.sh')
const realGo = '/usr/local/go/bin/go'
let server
async function run(command, env = {}, success = true) {
  const proc = Bun.spawn(command, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (success && code !== 0) throw new Error(`${command[0]} 失败（${code}）\n${stdout}\n${stderr}`)
  return { stdout, stderr, code }
}
function hashFiles(files) {
  const lines = Object.keys(files).sort().map(name => `${createHash('sha256').update(files[name]).digest('hex')}  ${name}\n`).join('')
  return `h1:${createHash('sha256').update(lines).digest('base64')}`
}
function zipFiles(files) {
  const locals = [], centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(text)
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, filename, data); centrals.push(central, filename)
    offset += local.length + filename.length + data.length
  }
  const end = Buffer.alloc(22), central = Buffer.concat(centrals)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}
try {
  const versions = ['1.0.0', '1.1.0'], archives = {}, modules = {}, sums = []
  const downloads = { npm: { '1.0.0': 0, '1.1.0': 0 }, go: { '1.0.0': 0, '1.1.0': 0 } }
  for (const version of versions) {
    const dir = join(root, `npm-${version}`)
    await mkdir(join(dir, 'package'), { recursive: true })
    await writeFile(join(dir, 'package/package.json'), JSON.stringify({ name: 'elysian-cache-fixture', version, main: 'index.js' }))
    await writeFile(join(dir, 'package/index.js'), `module.exports = '${version}'\n`)
    const archive = join(root, `npm-${version}.tgz`)
    await run(['tar', '-czf', archive, '-C', dir, 'package'])
    archives[version] = await readFile(archive)
    const mod = 'module example.test/cachedep\n\ngo 1.23.0\n'
    const files = { [`example.test/cachedep@v${version}/go.mod`]: mod, [`example.test/cachedep@v${version}/value.go`]: `package cachedep\nconst Value = "${version}"\n` }
    modules[version] = { zip: zipFiles(files), mod }
    sums.push(`example.test/cachedep v${version} ${hashFiles(files)}`, `example.test/cachedep v${version}/go.mod ${hashFiles({ 'go.mod': mod })}`)
  }
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/elysian-cache-fixture') {
      return Response.json({ name: 'elysian-cache-fixture', 'dist-tags': { latest: '1.1.0' }, versions: Object.fromEntries(versions.map(version => [version, {
        name: 'elysian-cache-fixture', version,
        dist: { tarball: `http://127.0.0.1:${server.port}/tar/npm-${version}.tgz`, integrity: `sha512-${createHash('sha512').update(archives[version]).digest('base64')}` },
      }])) })
    }
    const npm = /^\/tar\/npm-(1\.[01]\.0)\.tgz$/.exec(path)
    if (npm) { downloads.npm[npm[1]]++; return new Response(archives[npm[1]]) }
    const go = /^\/go\/example\.test\/cachedep\/@v\/v(1\.[01]\.0)\.(zip|mod|info)$/.exec(path)
    if (go) {
      const [, version, type] = go
      if (type === 'zip') { downloads.go[version]++; return new Response(modules[version].zip) }
      if (type === 'mod') return new Response(modules[version].mod)
      return Response.json({ Version: `v${version}`, Time: '2026-01-01T00:00:00Z' })
    }
    if (path === '/go/example.test/cachedep/@v/list') return new Response('v1.0.0\nv1.1.0\n')
    return new Response('fixture not found', { status: 404 })
  } })
  const origin = `http://127.0.0.1:${server.port}`
  const cache = join(root, 'persistent-cache'), bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'go'), `#!/bin/bash\nif [ "$1" = build ]; then shift; exec ${realGo} build -x "$@" 2>"$CACHE_TEST_GO_TRACE"; fi\nexec ${realGo} "$@"\n`, { mode: 0o755 })
  const environment = {
    PATH: `${bin}:${process.env.PATH}`, GOENV: 'off', GOTOOLCHAIN: 'local', GOSUMDB: 'off', GONOPROXY: 'none',
    ELYSIAN_GOPROXY: `${origin}/go`, ELYSIAN_BUN_REGISTRY: origin,
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'), GOMODCACHE: join(cache, 'go-mod'), GOCACHE: join(cache, 'go-build'), GOFLAGS: '-trimpath',
  }
  async function source(name, version = '1.0.0', stable = 'stable1') {
    const src = join(root, name, 'source')
    for (const dir of ['apps/web', 'apps/server-go/cmd/elysian', 'apps/server-go/internal/panel', 'apps/server-go/internal/stable', 'apps/server-go/web']) await mkdir(join(src, dir), { recursive: true })
    await writeFile(join(src, 'package.json'), JSON.stringify({ name: 'build-cache-fixture', private: true, scripts: { build: 'bun frontend.mjs' }, dependencies: { 'elysian-cache-fixture': version } }))
    await writeFile(join(src, 'frontend.mjs'), `await Bun.write('apps/web/dist/index.html', process.env.ELYSIAN_BUILD_COMMIT)\n`)
    await writeFile(join(src, 'apps/server-go/go.mod'), `module elysian/server\n\ngo 1.23.0\n\nrequire example.test/cachedep v${version}\n`)
    await writeFile(join(src, 'apps/server-go/go.sum'), sums.join('\n') + '\n')
    await writeFile(join(src, 'apps/server-go/internal/panel/version.go'), 'package panel\nvar Commit string\nvar BuildTime string\n')
    await writeFile(join(src, 'apps/server-go/internal/stable/stable.go'), `package stable\nimport "example.test/cachedep"\nfunc Value() string { return cachedep.Value + "-${stable}" }\n`)
    await writeFile(join(src, 'apps/server-go/web/embed.go'), 'package web\nimport "embed"\n//go:embed all:dist\nvar FS embed.FS\n')
    await writeFile(join(src, 'apps/server-go/cmd/elysian/main.go'), 'package main\nimport ("fmt"; "elysian/server/internal/panel"; "elysian/server/internal/stable"; "elysian/server/web")\nfunc main() { front,_:=web.FS.ReadFile("dist/index.html");fmt.Printf("%s|%s|%s|%s",panel.Commit,panel.BuildTime,stable.Value(),front) }\n')
    // 用独立缓存准备锁文件，不能提前预热被测持久缓存。
    await run(['bun', 'install', '--lockfile-only', '--cwd', src, '--registry', origin], { BUN_INSTALL_CACHE_DIR: join(root, 'lockfile-cache') })
    return src
  }
  async function build(src, commit, buildScript = script, success = true) {
    const output = join(src, '../artifact'), trace = join(src, '../go-trace.log')
    const result = await run(['bash', buildScript, src, output, commit], { ...environment, CACHE_TEST_GO_TRACE: trace }, success)
    if (!success) { assert.notEqual(result.code, 0); return }
    const executable = await run([join(output, 'elysian')])
    const fields = executable.stdout.split('|')
    assert.equal(fields[0], commit); assert.equal(fields[3], commit)
    assert.match(fields[1], /^\d{4}-\d{2}-\d{2}T/)
    return { trace: await readFile(trace, 'utf8'), value: fields[2] }
  }
  const compileStable = trace => /\/compile[^\n]* -p elysian\/server\/internal\/stable(?:\s|$)/.test(trace)
  const first = await source('cold'), beforeCold = structuredClone(downloads)
  const cold = await build(first, 'a'.repeat(40))
  assert.equal(downloads.npm['1.0.0'] - beforeCold.npm['1.0.0'], 1)
  assert.equal(downloads.go['1.0.0'] - beforeCold.go['1.0.0'], 1)
  assert(compileStable(cold.trace)); assert.equal(cold.value, '1.0.0-stable1')
  await rm(join(root, 'cold'), { recursive: true })
  const second = await source('warm'), beforeWarm = structuredClone(downloads)
  const legacy = join(root, 'legacy-build-release.sh')
  await writeFile(legacy, (await readFile(script, 'utf8')).replace('go build -trimpath ', 'go build '))
  const warm = await build(second, 'b'.repeat(40), legacy)
  assert.deepEqual(downloads, beforeWarm)
  assert(!compileStable(warm.trace), '换源码目录后未变化的 Go 包不应重新编译')
  assert.equal(warm.value, '1.0.0-stable1')
  console.log('✓ 冷构建下载依赖；换源码目录后 Bun / Go 均不重复下载，旧脚本通过 GOFLAGS 复用编译缓存')
  const changed = await source('changed', '1.0.0', 'stable2'), beforeChanged = structuredClone(downloads)
  const rebuilt = await build(changed, 'c'.repeat(40))
  assert(compileStable(rebuilt.trace)); assert.equal(rebuilt.value, '1.0.0-stable2'); assert.deepEqual(downloads, beforeChanged)
  console.log('✓ 源码变化正确重编译，前后端提交及构建时间正确注入')
  const upgraded = await source('dependency-changed', '1.1.0'), beforeUpgrade = structuredClone(downloads)
  const dependencyChanged = await build(upgraded, 'd'.repeat(40))
  assert.equal(downloads.npm['1.0.0'], beforeUpgrade.npm['1.0.0']); assert.equal(downloads.go['1.0.0'], beforeUpgrade.go['1.0.0'])
  assert.equal(downloads.npm['1.1.0'] - beforeUpgrade.npm['1.1.0'], 1); assert.equal(downloads.go['1.1.0'] - beforeUpgrade.go['1.1.0'], 1)
  assert.equal(dependencyChanged.value, '1.1.0-stable1')
  console.log('✓ 升级依赖仅下载缺少的新版本')
  const failed = await source('failed', '1.1.0')
  await writeFile(join(failed, 'frontend.mjs'), 'process.exit(7)\n')
  const beforeFailure = structuredClone(downloads)
  await build(failed, 'e'.repeat(40), script, false)
  await rm(join(root, 'failed'), { recursive: true })
  assert.deepEqual(downloads, beforeFailure)
  assert((await readFile(join(cache, 'go-mod/example.test/cachedep@v1.1.0/value.go'), 'utf8')).includes('1.1.0'))
  console.log('✓ 失败及临时目录清理保留持久缓存')
} finally {
  server?.stop(true)
  await rm(root, { recursive: true, force: true })
}

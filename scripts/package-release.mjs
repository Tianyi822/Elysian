import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const [source, output, commit, arch] = process.argv.slice(2)
if (!source || !output || !/^[a-f0-9]{40}$/.test(commit ?? '') || !['amd64', 'arm64'].includes(arch)) throw new Error('用法：package-release.mjs <源码目录> <产物目录> <完整提交> <amd64|arm64>')
const name = `elysian-linux-${arch}`
const directory = path.join(output, name)
fs.rmSync(directory, { recursive: true, force: true })
fs.mkdirSync(directory, { recursive: true })
for (const file of ['elysian', 'platform-helper']) fs.copyFileSync(path.join(output, file), path.join(directory, file))
const scripts = ['install.sh', 'install-release.sh', 'uninstall.sh', 'tui.sh', 'platform-lifecycle.sh', 'docker-apt.sh', 'install-platform.mjs', 'release-download.py', 'README-deploy.md']
fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true })
for (const file of scripts) {
  fs.copyFileSync(path.join(source, 'scripts', file), path.join(directory, 'scripts', file))
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const files = Object.fromEntries(['elysian', 'platform-helper', ...scripts.map(file => `scripts/${file}`)].map(file => [file, hash(path.join(directory, file))]))
fs.writeFileSync(path.join(directory, 'release.json'), `${JSON.stringify({ schema: 'elysian-release/v1', repository: 'Tianyi822/Elysian', commit, os: 'linux', arch, files }, null, 2)}\n`)
execFileSync('tar', ['-czf', path.join(output, `${name}.tar.gz`), '-C', output, name], { stdio: 'inherit' })
fs.writeFileSync(path.join(output, `${name}.tar.gz.sha256`), `${hash(path.join(output, `${name}.tar.gz`))}  ${name}.tar.gz\n`)

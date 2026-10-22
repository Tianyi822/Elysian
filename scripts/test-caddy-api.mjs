import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const socket = path.join(root, 'admin.sock')
const state = path.join(root, 'runtime.current.json')

function handler(channel) {
  return async request => {
    const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8').trim()
    const config = JSON.parse(fs.readFileSync(state, 'utf8'))
    const activeChannel = config.admin?.listen?.startsWith('unix/') ? 'unix' : 'tcp'
    const pathname = new URL(request.url).pathname
    fs.appendFileSync(path.join(root, 'requests'), `${request.method} ${channel} ${pathname}\n`)
    if (mode === 'no-api' || channel !== activeChannel) return new Response('', { status: 503 })
    if (mode === 'slow') await Bun.sleep(500)
    if (request.method === 'POST' && pathname === '/load') {
      const next = await request.json()
      if (mode === 'load-fail' && next.admin.listen.startsWith('unix/')) return new Response('', { status: 500 })
      if (mode === 'restore-fail' && !next.admin.listen.startsWith('unix/')) return new Response('', { status: 500 })
      fs.writeFileSync(state, JSON.stringify(next))
      return new Response('')
    }
    if (pathname !== '/config/') return new Response('', { status: 404 })
    if (channel === 'unix' && (mode === 'target-fail' || mode === 'restore-fail')) return new Response('', { status: 503 })
    if (channel === 'unix' && mode === 'invalid-json') return new Response('broken-json')
    return Response.json(config)
  }
}

const tcp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler('tcp') })
const unix = Bun.serve({ unix: socket, fetch: handler('unix') })
const disk = { admin: { listen: `127.0.0.1:${tcp.port}` }, apps: { http: { servers: { disk: {
  listen: [':8080'],
  routes: [{ handle: [{ handler: 'file_server', hide: [path.join(root, 'Caddyfile'), '/srv/private'] }] }],
} } } } }
const runtime = structuredClone(disk)
runtime.apps.http.servers.live = { listen: [':8443'], routes: [{ handle: [{ handler: 'static_response', body: 'existing dynamic route' }] }] }
runtime.apps.tls = { certificates: { load_pem: [{ certificate: 'private fixture certificate', key: 'private fixture key' }] } }
fs.writeFileSync(path.join(root, 'disk.json'), JSON.stringify(disk))
fs.writeFileSync(state, JSON.stringify(runtime))
fs.writeFileSync(path.join(root, 'runtime.original.json'), JSON.stringify(runtime))
fs.writeFileSync(path.join(root, 'Caddyfile'), `{\n\tadmin 127.0.0.1:${tcp.port}\n}\n:8080 {\n\troot * /srv\n\tfile_server {\n\t\thide /srv/private\n\t}\n}\n`)
fs.writeFileSync(path.join(root, 'ready'), '')

function close() {
  tcp.stop(true)
  unix.stop(true)
  process.exit(0)
}
process.on('SIGTERM', close)
process.on('SIGINT', close)

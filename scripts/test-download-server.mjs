import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const payload = Buffer.alloc(2 * 1024 * 1024, 'F')
fs.writeFileSync(path.join(root, 'expected.bin'), payload)

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 30,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    fs.appendFileSync(path.join(root, 'requests'), `${pathname}\n`)
    if (pathname === '/fast') return new Response(payload)
    if (pathname === '/metadata-hang') {
      await Bun.sleep(20000)
      return Response.json({ assets: [] })
    }
    if (pathname === '/slow') {
      let timer
      let sent = 0
      const stream = new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            controller.enqueue(Buffer.alloc(1024, 'S'))
            sent += 1024
            if (sent >= payload.length) { clearInterval(timer); controller.close() }
          }, 100)
        },
        cancel() { clearInterval(timer) },
      })
      return new Response(stream, { headers: { 'Content-Length': String(payload.length) } })
    }
    return new Response('not found', { status: 404 })
  },
})

fs.writeFileSync(path.join(root, 'url'), `http://127.0.0.1:${server.port}`)
function close() { server.stop(true); process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)

/*
 * 后端 API 服务端口：只监听容器内本机回环（127.0.0.1），不发布到宿主、
 * 不监听 0.0.0.0——浏览器从不直连，全部流量经 vite 的 server.proxy 同源转发。
 * 此值是唯一权威：apps/web/vite.config.ts 的代理目标引用这里。
 */
export const SERVER_PORT = 48101

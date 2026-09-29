/**
 * API 挂载路径常量：app.ts 装配、各片 404 兜底剥前缀与操作日志描述符表共用同一份
 * 字面量——单一事实，多处不漂移。本文件保持零依赖纯常量（与 allowedHostnames.ts
 * 同模式）：不 import hono、不 import node:*，浏览器侧构建链也能安全解析它。
 * 各片路由文件从本文件 import 并 re-export，既有 import 路径保持不变。
 */
export const DOCKER_MOUNT = '/api/docker'
export const DATABASE_MOUNT = '/api/databases'
export const FILES_MOUNT = '/api/files'
export const FIREWALL_MOUNT = '/api/security/firewall'
export const LOGS_MOUNT = '/api/logs'
export const SSH_MOUNT = '/api/security/ssh'
export const TERMINAL_MOUNT = '/api/terminals'
export const USERS_MOUNT = '/api/security/users'
export const WEBSITES_MOUNT = '/api/websites'

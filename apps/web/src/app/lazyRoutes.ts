import { lazy } from 'react'

/**
 * 路由级代码分割的唯一 importer 出口。lazy 组件与登录后的 idle 预取共用同一
 * Promise，避免重复请求同一块。登录页、NotFound 与顶栏页签件保持静态（见 router），
 * 不在此列：它们要么在会话闸门两跳内必须零额外请求，要么在外壳 Outlet 之外渲染。
 */
export const importers = {
  shell: () => import('./layout/AppShell'),
  dashboard: () => import('../features/dashboard/DashboardPage'),
  security: () => import('../features/security/SecurityPage'),
  container: () => import('../features/container/ContainerPage'),
  database: () => import('../features/database/DatabasePage'),
  files: () => import('../features/files/FilesPage'),
  logs: () => import('../features/logs/LogsPage'),
  terminal: () => import('../features/terminal/TerminalPage'),
  websites: () => import('../features/websites/WebsitesPage'),
  agent: () => import('../features/agent/AgentChatPage'),
  wiki: () => import('../features/memory/WikiPage'),
  settings: () => import('../features/settings/SettingsPage'),
} as const

export const AppShell = lazy(() => importers.shell().then(m => ({ default: m.AppShell })))
export const DashboardPage = lazy(() => importers.dashboard().then(m => ({ default: m.DashboardPage })))
export const SecurityPage = lazy(() => importers.security().then(m => ({ default: m.SecurityPage })))
export const ContainerPage = lazy(() => importers.container().then(m => ({ default: m.ContainerPage })))
export const DatabasePage = lazy(() => importers.database().then(m => ({ default: m.DatabasePage })))
export const FilesPage = lazy(() => importers.files().then(m => ({ default: m.FilesPage })))
export const LogsPage = lazy(() => importers.logs().then(m => ({ default: m.LogsPage })))
export const TerminalPage = lazy(() => importers.terminal().then(m => ({ default: m.TerminalPage })))
export const WebsitesPage = lazy(() => importers.websites().then(m => ({ default: m.WebsitesPage })))
export const AgentChatPage = lazy(() => importers.agent().then(m => ({ default: m.AgentChatPage })))
export const WikiPage = lazy(() => importers.wiki().then(m => ({ default: m.WikiPage })))
export const SettingsPage = lazy(() => importers.settings().then(m => ({ default: m.SettingsPage })))
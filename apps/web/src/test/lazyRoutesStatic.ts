// 测试替身：vitest 经 resolve.alias 用本文件替换 app/lazyRoutes，使页面与外壳在测试里
// 同步可用，避免路由级懒加载让既有同步断言落在 Suspense 降级态。生产构建不经过本文件，
// 仍走真实 lazyRoutes 的 React.lazy 分割；分割正确性由生产构建产物与浏览器实测保证。
import { AppShell } from '../app/layout/AppShell'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { SecurityPage } from '../features/security/SecurityPage'
import { ContainerPage } from '../features/container/ContainerPage'
import { DatabasePage } from '../features/database/DatabasePage'
import { FilesPage } from '../features/files/FilesPage'
import { LogsPage } from '../features/logs/LogsPage'
import { TerminalPage } from '../features/terminal/TerminalPage'
import { WebsitesPage } from '../features/websites/WebsitesPage'
import { AgentChatPage } from '../features/agent/AgentChatPage'
import { WikiPage } from '../features/memory/WikiPage'
import { SettingsPage } from '../features/settings/SettingsPage'

export {
  AppShell,
  DashboardPage,
  SecurityPage,
  ContainerPage,
  DatabasePage,
  FilesPage,
  LogsPage,
  TerminalPage,
  WebsitesPage,
  AgentChatPage,
  WikiPage,
  SettingsPage,
}

export const importers = {
  shell: async () => ({ AppShell }),
  dashboard: async () => ({ DashboardPage }),
  security: async () => ({ SecurityPage }),
  container: async () => ({ ContainerPage }),
  database: async () => ({ DatabasePage }),
  files: async () => ({ FilesPage }),
  logs: async () => ({ LogsPage }),
  terminal: async () => ({ TerminalPage }),
  websites: async () => ({ WebsitesPage }),
  agent: async () => ({ AgentChatPage }),
  wiki: async () => ({ WikiPage }),
  settings: async () => ({ SettingsPage }),
} as const
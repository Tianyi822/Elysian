import type { SettingsTab } from '../features/settings/settingsTabs'
import { createTabMemoryStore } from './tabMemoryStore'

export const useSettingsTabStore = createTabMemoryStore<SettingsTab>('maintenance')

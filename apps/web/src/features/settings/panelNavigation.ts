/** 浏览器导航出口；测试可以验证端口迁移而不实际离开测试页面。 */
export function openPanelAddress(address: string): void { window.location.assign(address) }
export function reloadPanelPage(): void { window.location.reload() }

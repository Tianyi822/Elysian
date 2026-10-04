/**
 * 工作区体积表达：与镜像表同档（配置文本不需要更大单位）。
 * 从工作区卡片抽出共用——构建预览与确认弹窗也按同一口径显示上下文字节数。
 */
export function formatWorkspaceSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

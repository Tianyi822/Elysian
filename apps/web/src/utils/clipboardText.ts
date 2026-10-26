/** HTTPS/localhost 优先异步剪贴板；HTTP IP 入口通过用户点击触发的复制命令回退。 */
export async function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return }
  if (typeof document.execCommand !== 'function') throw new Error('当前浏览器不支持复制，请手动选择文字复制。')
  const focused = document.activeElement
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const field = document.createElement('textarea')
  field.value = value
  field.readOnly = true
  field.tabIndex = -1
  field.setAttribute('aria-hidden', 'true')
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none'
  document.body.append(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    if (!document.execCommand('copy')) throw new Error('浏览器未能复制文字，请手动选择文字复制。')
  } finally {
    field.remove()
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true })
    if (selection && ranges.length) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
  }
}

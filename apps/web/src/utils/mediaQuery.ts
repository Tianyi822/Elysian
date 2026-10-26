/** 可选的显示偏好不能阻止页面加载；兼容仅提供旧式监听接口的宿主。 */
export function mediaQuery(query: string): MediaQueryList | undefined {
  try { return typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined }
  catch { return undefined }
}

export function observeMediaQuery(media: MediaQueryList | undefined, update: () => void): () => void {
  if (!media) return () => {}
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }
  if (typeof media.addListener === 'function') {
    media.addListener(update)
    return () => media.removeListener(update)
  }
  return () => {}
}

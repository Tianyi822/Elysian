import { useEffect, useRef, useState } from 'react'

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

/** 按词块消化增量，约 40ms 更新一批；积压越多越快，不给完整历史添加打字动画。 */
export function useSmoothedText(text: string, animate: boolean) {
  const [shown, setShown] = useState(animate ? '' : text)
  const current = useRef(shown)
  const target = useRef(text)
  target.current = text

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let frame = 0
    let previous = 0
    const display = (value: string) => { current.current = value; setShown(value) }
    const tick = (time: number) => {
      const value = target.current
      if (media?.matches || !animate) { display(value); return }
      if (!value.startsWith(current.current)) display('')
      if (time - previous >= 40) {
        const rest = value.slice(current.current.length)
        const count = Math.max(8, Math.ceil(rest.length * 0.4))
        let next = ''
        for (const { segment } of words.segment(rest)) {
          next += segment
          if (next.length >= count) break
        }
        display(current.current + next)
        previous = time
      }
      if (current.current !== target.current) frame = requestAnimationFrame(tick)
    }
    if (!animate || media?.matches || !text) display(text)
    else frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, animate])

  // 撤回或替换的快照不可在下一帧前继续显示旧内容。
  return !animate || !text ? text : text.startsWith(shown) ? shown : ''
}

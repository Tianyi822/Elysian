import { useRef } from 'react'
import type { KeyboardEvent } from 'react'

/**
 * 输入法的确认回车不是提交：组合中的回车在选词或上屏原字符，而部分引擎与输入法把这枚回车的
 * keydown 派发在 compositionend 之后（isComposing 已为 false、keyCode 13），只看组合态会漏掉它，
 * 表单的隐式提交随即发生。两种顺序都拦，并吞掉组合刚结束的那一枚回车；
 * setTimeout(0) 复位保证之后的人工回车不受影响。
 */
export function useImeEnterGuard() {
  const composing = useRef(false)
  const swallowEnter = useRef(false)

  const isImeKey = (event?: KeyboardEvent) => {
    if (composing.current) return true
    if (event && (event.nativeEvent.isComposing || event.keyCode === 229)) return true
    return swallowEnter.current && (event === undefined || event.key === 'Enter')
  }

  return {
    /** 挂到 <form> 即覆盖其中全部输入控件，也可挂到不在表单里的单个控件；捕获阶段先于控件自己的处理。 */
    guardProps: {
      onCompositionStartCapture: () => { composing.current = true },
      onCompositionEndCapture: () => {
        composing.current = false
        swallowEnter.current = true
        window.setTimeout(() => { swallowEnter.current = false }, 0)
      },
      onKeyDownCapture: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && isImeKey(event)) event.preventDefault()
      },
    },
    /** 显式按键处理与 onSubmit 的判定出口；不传事件时只看组合态与刚结束的那一枚回车。 */
    isImeKey,
  }
}
import { useLayoutEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import { PasswordVisibilityButton } from '../security/passwordFieldParts'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & { value: string }

/**
 * 始终使用原生文本编辑，圆点只画在不参与输入的独立层中。
 * 不切换 type、不使用 text-security，也不将实际 value 替换为掩码字符，
 * 避免 Chromium 的密码安全输入路径改变 macOS 的输入源。
 */
export function LoginPasswordInput({ value, className = '', ...props }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [visible, setVisible] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [selection, setSelection] = useState({ start: 0, end: 0, focused: false })
  const sync = () => {
    const field = input.current
    if (!field) return
    setScroll(field.scrollLeft)
    setSelection({ start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0, focused: document.activeElement === field })
  }
  useLayoutEffect(sync, [value, visible])
  // 字符簇保持组合附加符、emoji 与输入法提交的字符完整，宽度由同字体的浏览器排版测量。
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]

  return <div className="relative">
    <input {...props} ref={input} type="text" value={value}
      autoCapitalize="none" autoCorrect="off" spellCheck={false}
      className={`${className} login-password-input ${visible ? '' : 'login-password-masked'}`}
      onSelect={sync} onScroll={sync} onFocus={sync} onBlur={sync}
      onCopy={(event) => { if (!visible) event.preventDefault() }}
      onCut={(event) => { if (!visible) event.preventDefault() }} />
    {!visible && <div aria-hidden="true" className="login-password-mask">
      <span className="login-password-mask-content" style={{ transform: `translateX(${-scroll}px)` }}>
        {segments.map(({ segment, index }) => <span key={index} className="login-password-mask-character"
          data-selected={selection.focused && index < selection.end && index + segment.length > selection.start ? '' : undefined}>
          {segment}
        </span>)}
      </span>
    </div>}
    <PasswordVisibilityButton visible={visible} onToggle={(next) => {
      const field = input.current
      const start = field?.selectionStart ?? value.length
      const end = field?.selectionEnd ?? start
      setVisible(next)
      field?.focus()
      field?.setSelectionRange(start, end)
    }} />
  </div>
}

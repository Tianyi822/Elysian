import { describe, expect, it } from 'vitest'
import { formatTerminalColumns, hostTerminalCloseMessage, segmentTerminalText } from './terminalSession'

describe('segmentTerminalText', () => {
  it('纯半角文本是一段', () => {
    expect(segmentTerminalText('drwxr-xr-x  2 root root')).toEqual([
      { text: 'drwxr-xr-x  2 root root', wide: false },
    ])
  })

  it('宽字符各自成段，半角连续成段', () => {
    expect(segmentTerminalText('| 1  | 巡检 |')).toEqual([
      { text: '| 1  | ', wide: false },
      { text: '巡', wide: true },
      { text: '检', wide: true },
      { text: ' |', wide: false },
    ])
  })

  it('零宽附加符并入前一段', () => {
    expect(segmentTerminalText('✅\ufe0f ok')).toEqual([
      { text: '✅\ufe0f', wide: true },
      { text: ' ok', wide: false },
    ])
  })
})

describe('formatTerminalColumns', () => {
  it('放得下时排成一行，列间隔两格', () => {
    expect(formatTerminalColumns(['.ssh', 'Documents', 'Downloads'])).toEqual([
      '.ssh  Documents  Downloads',
    ])
  })

  it('放不下时先竖后横分栏，每列按该列最宽条目对齐，行尾不留空格', () => {
    const items = ['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'media']
    expect(formatTerminalColumns(items, 17)).toEqual([
      'bin   etc   media',
      'boot  home',
      'dev   lib',
    ])
  })

  it('宽字符按两格计宽', () => {
    expect(formatTerminalColumns(['巡检', 'ab', 'c'], 5)).toEqual(['巡检', 'ab', 'c'])
    expect(formatTerminalColumns(['巡检', 'ab', 'cd', 'ef'], 10)).toEqual(['巡检  cd', 'ab    ef'])
  })

  it('单个条目超过行宽时一行一个；空清单不产出行', () => {
    expect(formatTerminalColumns(['a-very-long-name', 'b'], 8)).toEqual(['a-very-long-name', 'b'])
    expect(formatTerminalColumns([])).toEqual([])
  })
})

describe('hostTerminalCloseMessage', () => {
  it('4000 空闲超时；1008 透传 reason；其余按连接中断兜底', () => {
    expect(hostTerminalCloseMessage(4000, '')).toBe('终端会话空闲超时，已断开')
    expect(hostTerminalCloseMessage(1008, '并发终端会话已达上限（5）')).toBe(
      '并发终端会话已达上限（5）',
    )
    expect(hostTerminalCloseMessage(1008, '')).toBe('本机终端连接中断')
    expect(hostTerminalCloseMessage(1006, '')).toBe('本机终端连接中断')
    expect(hostTerminalCloseMessage(4500, '')).toBe('本机终端连接中断')
  })

  it('兜底措辞可按域替换，映射逻辑不变', () => {
    expect(hostTerminalCloseMessage(1006, '', '容器终端连接中断')).toBe('容器终端连接中断')
    expect(hostTerminalCloseMessage(1008, '', '容器终端连接中断')).toBe('容器终端连接中断')
    expect(hostTerminalCloseMessage(4000, '', '容器终端连接中断')).toBe('终端会话空闲超时，已断开')
    expect(hostTerminalCloseMessage(1008, '被服务端拒绝', '容器终端连接中断')).toBe('被服务端拒绝')
  })
})

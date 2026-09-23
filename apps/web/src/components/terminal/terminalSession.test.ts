import { describe, expect, it } from 'vitest'
import { formatTerminalColumns, segmentTerminalText } from './terminalSession'

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

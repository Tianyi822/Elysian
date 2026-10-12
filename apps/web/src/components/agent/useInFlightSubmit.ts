import { useCallback, useRef, useState } from 'react'
import { AGENT_REQUEST_ID_PATTERN } from '../../adapters/http/agent/agentShared'

/*
 * 提交进行态 hook 的双档 API。铁律：只有服务端输入体声明了 requestId 字段的
 * 七类提交（新建任务/续轮、批次提交、技能导入、提炼创建、索引重建、工作流实例
 * 创建、工作流恢复）可用 withRequestId 档；其余全部写端点用 inFlightOnly 档——
 * 连点单飞锁＋提交期间 disabled，requestId 绝不进 body（那些体经
 * DisallowUnknownFields 解码，多带字段即 400）。幂等由服务端语义承担。
 * 页面刷新后绝不自动重放任何提交。
 */

function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 测试或旧环境的回落：只保证唯一性与格式，不承担加密强度。
  let value = ''
  for (let index = 0; index < 32; index += 1) {
    value += Math.floor(Math.random() * 16).toString(16)
  }
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function useInFlightSubmit() {
  const [submitting, setSubmitting] = useState(false)
  const runningRef = useRef(false)
  const requestIdRef = useRef<string | undefined>(undefined)

  /** 作废当前幂等键并生成新的；新一轮内容不同的提交前调用。 */
  const newRequestId = useCallback((): string => {
    const value = randomRequestId()
    requestIdRef.current = value
    return value
  }, [])

  /**
   * 档一：requestId 白名单端点。第一次提交生成幂等键，之后复用同一键
   * （重试按幂等回读）；连点单飞锁期间直接返回 undefined，不重放。
   */
  const withRequestId = useCallback(async <T,>(submit: (requestId: string) => Promise<T>): Promise<T | undefined> => {
    if (runningRef.current) return undefined
    if (requestIdRef.current === undefined) newRequestId()
    const requestId = requestIdRef.current
    if (requestId === undefined || !AGENT_REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error('requestId 必须以字母或数字开头，仅含字母、数字与 . _ : -，长度 1 到 128')
    }
    runningRef.current = true
    setSubmitting(true)
    try {
      return await submit(requestId)
    } finally {
      runningRef.current = false
      setSubmitting(false)
    }
  }, [newRequestId])

  /** 档二：无 requestId 字段的写端点。单飞锁＋提交期间 disabled；绝不注入 requestId。 */
  const inFlightOnly = useCallback(async <T,>(submit: () => Promise<T>): Promise<T | undefined> => {
    if (runningRef.current) return undefined
    runningRef.current = true
    setSubmitting(true)
    try {
      return await submit()
    } finally {
      runningRef.current = false
      setSubmitting(false)
    }
  }, [])

  return { submitting, withRequestId, inFlightOnly, newRequestId }
}

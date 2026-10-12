import { useCallback, useRef, useState } from 'react'

/** 模型表单提交期间阻止重复提交，不自动重放失败请求。 */
export function useInFlightSubmit() {
  const [submitting, setSubmitting] = useState(false)
  const runningRef = useRef(false)

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

  return { submitting, inFlightOnly }
}

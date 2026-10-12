import { vi } from 'vitest'

/*
 * Agent 域测试工具：JSON 响应 fetch stub、fake-timers 轮询推进工具
 * 出口。renderApp 复用既有 test/renderApp.tsx；轮询断言一律经 advancePoll
 * 推进 fake timers，不真等时间。
 */

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input)
}

/**
 * 按路径（忽略查询串）返回预置 JSON 的 fetch stub；未登记路径回 404 错误体，
 * 让「请求落错端点」在断言前就显形。用 vi.stubGlobal('fetch', stub) 挂上。
 */
export function stubAgentJsonFetch(routes: Readonly<Record<string, unknown>>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = urlOf(input)
    const path = url.split('?')[0]
    const hit = Object.entries(routes).find(([route]) => route === path)
    if (hit === undefined) {
      return new Response(JSON.stringify({ error: `测试未登记的 Agent 端点：${url}`, code: 'not-stubbed' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(hit[1]), { headers: { 'content-type': 'application/json' } })
  })
}

/** 推进 fake timers 并让已排定的微任务跑完；轮询节奏断言统一走这里。 */
export async function advancePoll(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

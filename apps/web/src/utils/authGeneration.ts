let authGeneration = 0

/** 在异步操作开始前记录登录代次，用于拒绝旧会话的回执。 */
export function captureAuthGeneration(): number { return authGeneration }

/** 仅登录、登出或会话状态切换时推进，普通后台探测不推进。 */
export function advanceAuthGeneration(): void { authGeneration += 1 }

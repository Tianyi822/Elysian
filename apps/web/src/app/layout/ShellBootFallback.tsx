import { LoadingState } from '../../components/states/StateViews'

/** 外壳块到达前的整屏降级：与登录页同一画布令牌，避免背景跳变。 */
export function ShellBootFallback() {
  return (
    <div className="app-canvas flex h-dvh items-center justify-center p-4 md:p-6">
      <LoadingState label="正在加载工作台…" />
    </div>
  )
}
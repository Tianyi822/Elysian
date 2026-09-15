import { useContainersStore } from '../../stores/containersStore'

/**
 * 容器/镜像视图切换。经路由 handle 挂进顶栏标题旁，与页内工具栏共用同一 store，
 * 视图状态不进 URL。
 */
export function ContainerViewSwitch() {
  const view = useContainersStore((s) => s.view)
  const setView = useContainersStore((s) => s.setView)

  return (
    <div
      role="group"
      aria-label="视图切换"
      className="inline-flex overflow-hidden rounded-lg border border-line"
    >
      <button
        type="button"
        aria-pressed={view === 'grid'}
        onClick={() => setView('grid')}
        className={`whitespace-nowrap px-2 py-1.5 text-xs transition-colors sm:px-3 ${
          view === 'grid'
            ? 'bg-surface-raised font-medium text-fg'
            : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
        }`}
      >
        容器
      </button>
      <button
        type="button"
        aria-pressed={view === 'images'}
        onClick={() => setView('images')}
        className={`whitespace-nowrap border-l border-line px-2 py-1.5 text-xs transition-colors sm:px-3 ${
          view === 'images'
            ? 'bg-surface-raised font-medium text-fg'
            : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
        }`}
      >
        镜像
      </button>
    </div>
  )
}

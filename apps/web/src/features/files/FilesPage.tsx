import { EmptyState } from '../../components/states/StateViews'

/**
 * 文件管理页骨架：入口、路由与权限闸门已经就位，目录树与文件操作待接入。
 * 本页不读任何适配数据，加载与错误状态无从产生，空状态就是它当前的真实状态。
 */
export function FilesPage() {
  return (
    <section aria-label="文件管理">
      <EmptyState
        title="还没有可浏览的文件"
        description="这一页目前是空白骨架：文件适配器与目录树尚未接入，在接上之前不摆演示文件树。"
      />
    </section>
  )
}

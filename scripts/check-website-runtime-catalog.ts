import { createWebsiteRuntimeCatalogService } from '../apps/server/src/websites/websiteRuntimeCatalog.ts'

/** 诊断后端的真实自动获取路径；不生成或维护固定版本文件。 */
const report = await createWebsiteRuntimeCatalogService().get()
let total = 0
for (const [kind, entries] of Object.entries(report.catalog)) {
  console.log(kind + '：' + entries.length + ' 个正式版本选项')
  total += entries.length
}
console.log('已从官方发布记录与 Docker 官方镜像库自动核对 ' + total + ' 个选项')

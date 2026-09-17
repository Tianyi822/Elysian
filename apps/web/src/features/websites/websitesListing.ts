import type { WebsiteCategory, WebsiteProject } from '@elysian/contracts'

/*
 * 网站列表的过滤。纯函数：不碰 store、不发请求，
 * 面板把筛选条件交给它，拿回当前筛选下要呈现的卡片列表。
 */

export type WebsitesFilter = {
  category: WebsiteCategory | 'all'
  search: string
}

/** 分类 + 搜索叠加过滤；搜索对名称与备注做大小写不敏感的子串匹配。 */
export function filterWebsiteProjects(
  projects: readonly WebsiteProject[],
  filter: WebsitesFilter,
): readonly WebsiteProject[] {
  const keyword = filter.search.trim().toLowerCase()
  return projects.filter((project) => {
    if (filter.category !== 'all' && project.category !== filter.category) return false
    if (!keyword) return true
    return (
      project.name.toLowerCase().includes(keyword) ||
      (project.note ?? '').toLowerCase().includes(keyword)
    )
  })
}

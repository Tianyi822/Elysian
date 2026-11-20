package files

import (
	"context"
)

// 搜索结果条数上限：触顶即停止遍历返回已命中部分。
const searchMaxResults = 1000

// fileSearchResult 一条搜索结果：条目本身的全量字段外加它在树中的绝对路径。
type fileSearchResult struct {
	fileEntry
	Path string `json:"path"`
}

// Search 全树搜索：契约 matchesFilePath 口径（去全部空白+小写，名称或完整路径任一
// 命中）。遍历全程 lstat 不跟随（防循环与 /proc、/sys 陷阱），命中条目的呈现与 list
// 同口径：逐条补一次跟随 stat（契约「符号链接按其指向呈现，不单列一类」），断链才
// 回退 lstat——与 list 共用 statListedEntry，两个读路径的条目字段不会各说各话。
// 触顶即静默截断：报错替代截断会让 `/` 下搜常见词必然失败，搜索整体不可用，两害取其轻。
func (s *filesService) Search(ctx context.Context, keyword string) ([]fileSearchResult, error) {
	if normalizeFileSearch(keyword) == "" {
		return []fileSearchResult{}, nil // 空关键词不碰文件系统
	}
	uidNames, err := s.uidNameMap(ctx)
	if err != nil {
		return nil, err
	}
	type matchedEntry struct {
		path string
		name string
	}
	matched := []matchedEntry{}
	_, err = walkFileTree(s.deps, "/", walkOptions{
		virtualDirs: virtualPrune,
		onLimit:     limitStop,
		extraPrune: func(entryPath, entryName string) bool {
			for _, pruneName := range searchPruneDirNames {
				if entryName == pruneName {
					return true
				}
			}
			_, hit := matchPathPrefix(entryPath, s.searchPrunePrefixes)
			return hit
		},
		onEntry: func(entry walkEntry) bool {
			if matchesFilePath(keyword, entry.name, entry.path) {
				matched = append(matched, matchedEntry{path: entry.path, name: entry.name})
			}
			return len(matched) < searchMaxResults
		},
	})
	if err != nil {
		return nil, err
	}
	results := make([]fileSearchResult, 0)
	for _, entry := range matched {
		stats, err := s.statListedEntry(entry.path)
		if err != nil {
			return nil, err
		}
		if stats == nil {
			continue
		}
		results = append(results, fileSearchResult{fileEntry: entryOf(entry.name, *stats, uidNames), Path: entry.path})
	}
	return results, nil
}

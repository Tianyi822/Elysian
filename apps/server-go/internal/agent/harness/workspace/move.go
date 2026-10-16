package workspace

import "context"

// PrepareCopy preserves the source bytes from the exact immutable base version.
// Destinations must be absent; overwrites require a separate write operation.
func (s *Store) PrepareCopy(ctx context.Context, taskID string, baseRevision int, source, target string, move bool) (Version, error) {
	if err := validatePath(source); err != nil {
		return Version{}, err
	}
	if err := validatePath(target); err != nil {
		return Version{}, err
	}
	if source == target {
		return Version{}, problem(400, "workspace_same_path", "源路径与目标路径相同")
	}
	return s.prepare(ctx, taskID, baseRevision, func(base *loadedVersion, _ int64) ([]archiveEntry, func(), error) {
		var copied *archiveEntry
		entries := make([]archiveEntry, 0, len(base.entries)+1)
		for _, entry := range base.entries {
			if entry.Path == target {
				return nil, nil, problem(409, "workspace_target_exists", "目标文件已存在")
			}
			if entry.Path == source {
				next := entry
				next.Path = target
				copied = &next
				if move {
					continue
				}
			}
			entries = append(entries, entry)
		}
		if copied == nil {
			return nil, nil, problem(404, "workspace_file_not_found", "工作区文件不存在")
		}
		return append(entries, *copied), nil, nil
	})
}

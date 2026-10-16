package harness

import (
	"path/filepath"
	"strings"

	"elysian/server/internal/agent/jsonvalue"
)

// Administrative resource grants are fixed in the run snapshot. Approval and
// full mode never enlarge the target set declared by those grants.
func authorizeOperationScope(s CapabilitySnapshot, o Operation) error {
	c := o.Capability
	if c.Source != "builtin" {
		return nil
	}
	if c.Metadata.Exposure != "" && c.Metadata.Exposure != "agent" {
		return bad("tool-human-required", "该操作必须通过人工管理入口执行")
	}
	if allowed(c.Name) {
		return nil
	}
	args, err := jsonvalue.Object([]byte(o.ArgumentsJSON))
	if err != nil {
		return err
	}
	if c.Metadata.ResourceType == "filesystem" {
		root, _ := args[c.Metadata.ResourceKeyArgument].(string)
		if !filepath.IsAbs(root) {
			return bad("resource-denied", "文件根目录必须是明确的绝对路径")
		}
		paths := []string{root}
		for _, key := range []string{"path", "target"} {
			if value, ok := args[key].(string); ok && value != "" {
				if filepath.IsAbs(value) {
					return bad("resource-denied", "文件路径必须相对已授权根目录")
				}
				paths = append(paths, filepath.Join(root, value))
			}
		}
		for _, target := range paths {
			granted := false
			for _, grant := range s.Grants {
				if !grant.Enabled {
					continue
				}
				for _, directory := range grant.Directories {
					if !c.ReadOnly && directory.Access != "rw" {
						continue
					}
					rel, err := filepath.Rel(filepath.Clean(directory.Path), filepath.Clean(target))
					if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
						granted = true
					}
				}
			}
			if !granted {
				return bad("resource-denied", "文件目标不在本轮固定的目录授权范围内")
			}
		}
		return nil
	}
	if c.ReadOnly {
		return nil
	}
	resourceType := c.Metadata.ResourceType
	resourceID, _ := args[c.Metadata.ResourceKeyArgument].(string)
	if resourceType == "" || resourceID == "" || resourceID == "*" {
		return bad("resource-denied", "平台变更必须绑定明确的授权对象")
	}
	for _, grant := range s.Grants {
		if !grant.Enabled {
			continue
		}
		for _, resource := range grant.Resources {
			if resource.Domain == resourceType && resource.ID == resourceID && resource.Access == "write" {
				return nil
			}
		}
	}
	return bad("resource-denied", "平台对象未获得本轮固定的写入授权")
}

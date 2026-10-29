package harness

import "strings"

type PermissionMode string

const (
	PermissionAsk           PermissionMode = "ask"
	PermissionAssist        PermissionMode = "assist"
	PermissionFull          PermissionMode = "full"
	PermissionPolicyVersion                = "permission-modes/v2"
)

func normalizePermissionMode(mode PermissionMode) (PermissionMode, error) {
	if mode == "" {
		return PermissionAsk, nil
	}
	switch mode {
	case PermissionAsk, PermissionAssist, PermissionFull:
		return mode, nil
	default:
		return "", bad("invalid-permission-mode", "权限模式必须为 ask、assist 或 full")
	}
}

// Omitted mode and explicit ask share the legacy idempotency representation.
func canonicalPermissionMode(mode PermissionMode) PermissionMode {
	if mode == PermissionAsk {
		return ""
	}
	return mode
}

// This allowlist is owned by the harness; a plugin's readOnly annotation alone
// cannot turn a new operation into an approval-free platform read.
func confirmedPlatformRead(c Capability) bool {
	if !c.ReadOnly {
		return false
	}
	if allowed(c.Name) {
		return true
	}
	if c.Metadata.Exposure != "agent" || !c.Metadata.ReadOnly {
		return false
	}
	switch c.Name {
	case "file_list", "file_read", "security_snapshot", "security_users", "security_login_records",
		"firewall_snapshot", "firewall_connections", "firewall_stats", "database_list", "database_metadata", "database_discover", "database_metrics", "database_task_status", "database_task_logs",
		"logs_read", "platform_memory", "platform_metrics", "platform_dependencies", "panel_info", "panel_update_check", "panel_update_history", "web_fetch",
		"registry_host_check", "docker_container_inspect", "docker_image_inspect", "docker_image_search", "docker_image_tags", "docker_image_pull_get", "docker_image_pull_logs", "website_list", "caddy_config_current", "website_runtimes", "website_source_get", "website_source_analysis",
		"website_deployments_list", "website_deployment_get", "website_deployment_logs", "website_logs",
		"app_list", "app_lookup", "app_directory", "workspace_list_files", "workspace_read_file", "compose_check",
		"app_workspace_snapshot", "app_build_logs", "app_build_preview", "build_list", "build_get", "build_preview", "build_logs":
		return true
	}
	return false
}

func operationDecision(s CapabilitySnapshot, o Operation) (bool, string) {
	c := o.Capability
	if c.Source == "builtin" && c.Metadata.Exposure != "" && c.Metadata.Exposure != "agent" {
		return false, "human-approval"
	}
	if c.Source == "wiki" || trusted(s, c) {
		return true, "trusted-read-only"
	}
	// External capabilities keep their independent explicit trust/approval rules.
	managed := s.PolicyVersion == PermissionPolicyVersion && strings.HasPrefix(c.Source, "mcp-") || c.Source == "workspace" || isBashSource(c.Source) || c.Source == "script" || c.Source == "builtin"
	if !managed {
		return false, "human-approval"
	}
	mode, _ := normalizePermissionMode(s.PermissionMode)
	if mode == PermissionFull {
		return true, "full-authorized"
	}
	if mode == PermissionAssist {
		if c.Source == "workspace" && !c.ReadOnly {
			return true, "assist-workspace"
		}
		if (isBashSource(c.Source) || c.Source == "script") && o.Execution != nil {
			g := o.Execution.Grant
			isolated := g == nil
			if g != nil && len(g.Network) == 0 {
				isolated = true
				for _, directory := range g.Directories {
					if directory.Access != "ro" {
						isolated = false
					}
				}
			}
			if isolated {
				return true, "assist-isolated"
			}
		}
	}
	return false, "human-approval"
}

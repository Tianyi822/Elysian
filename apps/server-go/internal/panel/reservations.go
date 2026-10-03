package panel

import (
	"elysian/server/internal/config"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// 仅读登记的端口和任务状态；维护包不依赖网站域的实现类型。
func checkPanelReservations(root string, ports config.PanelNetwork) error {
	b, err := os.ReadFile(filepath.Join(root, "config", "websites.json"))
	if err == nil {
		var rows []struct {
			Port int `json:"port"`
		}
		if json.Unmarshal(b, &rows) != nil {
			return fmt.Errorf("网站登记损坏，无法核对预留端口")
		}
		for _, row := range rows {
			if row.Port == ports.FrontendPort || row.Port == ports.BackendPort {
				return fmt.Errorf("端口 %d 已由网站项目保留", row.Port)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	patterns := []string{filepath.Join(root, "state", "website-deployments", "*.json"), filepath.Join(root, "tmp", "website-sources", "*", "source.json")}
	for _, pattern := range patterns {
		files, err := filepath.Glob(pattern)
		if err != nil {
			return err
		}
		for _, file := range files {
			b, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			var row struct {
				State string `json:"state"`
			}
			if json.Unmarshal(b, &row) != nil {
				return fmt.Errorf("网站任务登记损坏，无法开始面板维护")
			}
			switch row.State {
			case "queued", "building", "publishing", "preparing":
				return fmt.Errorf("网站源码获取或部署任务尚未结束，请完成后再维护面板")
			}
		}
	}
	return nil
}

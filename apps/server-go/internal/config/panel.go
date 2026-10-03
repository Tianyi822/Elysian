package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// PanelNetwork 是正式安装版的端口事实；域包只消费装配层注入的快照。
type PanelNetwork struct {
	FrontendPort int `json:"frontendPort"`
	BackendPort  int `json:"backendPort"`
}

func DefaultPanelNetwork() PanelNetwork { return PanelNetwork{48100, 48101} }

func (p PanelNetwork) Validate() error {
	if p.FrontendPort < 1 || p.FrontendPort > 65535 || p.BackendPort < 1 || p.BackendPort > 65535 {
		return fmt.Errorf("端口必须是 1–65535 的整数")
	}
	if p.FrontendPort == p.BackendPort {
		return fmt.Errorf("前端与后端端口不能相同")
	}
	return nil
}

func (c *Config) PanelPorts() PanelNetwork {
	if c.Network == (PanelNetwork{}) {
		return DefaultPanelNetwork()
	}
	return c.Network
}

func ReadPanelNetwork(filename string) (PanelNetwork, error) {
	b, err := os.ReadFile(filename)
	if os.IsNotExist(err) {
		return DefaultPanelNetwork(), nil
	}
	if err != nil {
		return PanelNetwork{}, err
	}
	var p PanelNetwork
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(&p); err != nil {
		return p, fmt.Errorf("面板端口配置损坏：%w", err)
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return p, fmt.Errorf("面板端口配置存在多余内容")
	}
	if err = p.Validate(); err != nil {
		return p, fmt.Errorf("面板端口配置无效：%w", err)
	}
	return p, nil
}

// AtomicJSON 临时文件与目标同目录，fsync 后 rename，不留下半写的配置或任务。
func AtomicJSON(filename string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(filename), ".panel-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(b, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), filename)
	}
	if err == nil {
		dir, e := os.Open(filepath.Dir(filename))
		if e != nil {
			return e
		}
		defer dir.Close()
		err = dir.Sync()
	}
	return err
}

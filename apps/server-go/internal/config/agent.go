package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// AgentRuntime 是 config/agent/runtime.json 的启动时快照。
type AgentRuntime struct {
	Version     int `json:"version"`
	Concurrency int `json:"concurrency"`
}

func DefaultAgentRuntime() AgentRuntime { return AgentRuntime{Version: 1, Concurrency: 2} }

// ReadAgentRuntime 仅读新路径；文件缺失采用缺省值，损坏或非法值拒绝启动。
func ReadAgentRuntime(filename string) (AgentRuntime, error) {
	info, err := os.Lstat(filename)
	if errors.Is(err, os.ErrNotExist) {
		return DefaultAgentRuntime(), nil
	}
	if err != nil {
		return AgentRuntime{}, fmt.Errorf("读取 Agent 运行配置失败：%w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return AgentRuntime{}, errors.New("Agent 运行配置必须为不超过 4 KiB 的普通文件")
	}
	raw, err := os.ReadFile(filename)
	if err != nil {
		return AgentRuntime{}, fmt.Errorf("读取 Agent 运行配置失败：%w", err)
	}
	if len(raw) > 4096 {
		return AgentRuntime{}, errors.New("Agent 运行配置不得超过 4 KiB")
	}
	var runtime AgentRuntime
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&runtime); err != nil {
		return AgentRuntime{}, fmt.Errorf("Agent 运行配置格式无效：%w", err)
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return AgentRuntime{}, errors.New("Agent 运行配置存在多余内容")
	}
	if runtime.Version != 1 || runtime.Concurrency < 1 || runtime.Concurrency > 4 {
		return AgentRuntime{}, errors.New("Agent 运行配置 version 必须为 1，concurrency 必须为 1 至 4 的整数")
	}
	return runtime, nil
}

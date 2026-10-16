// Package config 管理容器执行配置与管理员目录、网络授权的不可变修订。
package config

import (
	"time"
)

const (
	MaxTimeoutSeconds       = 300
	MaxCPUMillis            = 1000
	MaxMemoryBytes    int64 = 512 << 20
	MaxPIDs                 = 128
)

type Options struct {
	MountRoot string
	Now       func() time.Time
}

type Profile struct {
	ID             string   `json:"id"`
	Revision       int      `json:"revision"`
	Enabled        bool     `json:"enabled"`
	Name           string   `json:"name"`
	Image          string   `json:"image"`
	Runtime        string   `json:"runtime"`
	Command        []string `json:"command"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	CPUMillis      int      `json:"cpuMillis"`
	MemoryBytes    int64    `json:"memoryBytes"`
	PIDs           int      `json:"pids"`
	CreatedAt      string   `json:"createdAt"`
}

type ProfileInput struct {
	ID               string   `json:"id,omitempty"`
	ExpectedRevision int      `json:"expectedRevision"`
	Enabled          bool     `json:"enabled"`
	Name             string   `json:"name"`
	Image            string   `json:"image"`
	Runtime          string   `json:"runtime"`
	Command          []string `json:"command"`
	TimeoutSeconds   int      `json:"timeoutSeconds"`
	CPUMillis        int      `json:"cpuMillis"`
	MemoryBytes      int64    `json:"memoryBytes"`
	PIDs             int      `json:"pids"`
}

type Directory struct {
	Path   string `json:"path"`
	Access string `json:"access"`
}

type NetworkEndpoint struct {
	Scheme string `json:"scheme"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
}

// Resource identifies one platform object; wildcards never grant new targets.
type Resource struct {
	Domain string `json:"domain"`
	ID     string `json:"id"`
	Access string `json:"access"`
}

type Grant struct {
	ID           string            `json:"id"`
	Revision     int               `json:"revision"`
	Enabled      bool              `json:"enabled"`
	Name         string            `json:"name"`
	Directories  []Directory       `json:"directories"`
	Network      []NetworkEndpoint `json:"network"`
	PrivateCIDRs []string          `json:"privateCidrs"`
	Resources    []Resource        `json:"resources,omitempty"`
	CreatedAt    string            `json:"createdAt"`
}

type GrantInput struct {
	ID               string            `json:"id,omitempty"`
	ExpectedRevision int               `json:"expectedRevision"`
	Enabled          bool              `json:"enabled"`
	Name             string            `json:"name"`
	Directories      []Directory       `json:"directories"`
	Network          []NetworkEndpoint `json:"network"`
	PrivateCIDRs     []string          `json:"privateCidrs"`
	Resources        []Resource        `json:"resources,omitempty"`
}

type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	cause   error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.cause }
func problem(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}
func storageError(err error) *Error {
	return &Error{Status: 500, Code: "execution_config_storage", Message: "执行配置存储操作失败", cause: err}
}

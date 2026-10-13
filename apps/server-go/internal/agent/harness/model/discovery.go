package model

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"elysian/server/internal/agent/jsonvalue"
)

// DiscoveryInput 只用于读取，不保存草稿或生成配置修订。
type DiscoveryInput struct {
	ServiceID        string  `json:"serviceId,omitempty"`
	ExpectedRevision int     `json:"expectedRevision,omitempty"`
	Provider         string  `json:"provider"`
	APIFormat        string  `json:"apiFormat"`
	BaseURL          string  `json:"baseUrl"`
	Credential       *string `json:"credential,omitempty"`
}

// DiscoveredModel 仅回送已验证的公开元数据，不透传上游任意字段。
type DiscoveredModel struct {
	Model         string `json:"model"`
	Name          string `json:"name"`
	ContextTokens *int   `json:"contextTokens,omitempty"`
	OutputTokens  *int   `json:"outputTokens,omitempty"`
}

type CatalogClient interface {
	ListModels(context.Context, Profile) ([]DiscoveredModel, error)
}

func NewCatalogClient(client *http.Client) CatalogClient {
	return NewClient(client).(*httpClient)
}

// DiscoveryProfile 在配置锁内校验修订并读取凭据；改地址不能携带已保存的密钥。
func (s *Store) DiscoveryProfile(input DiscoveryInput) (Profile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	credential := ""
	if input.ServiceID == "" && input.ExpectedRevision != 0 {
		return Profile{}, problem(400, "invalid-discovery", "读取已保存凭据时必须提供服务编号和当前修订")
	}
	if input.ServiceID != "" {
		var found *Service
		for _, service := range s.servicesLocked() {
			if service.ID == input.ServiceID {
				found = &service
				break
			}
		}
		if found == nil {
			return Profile{}, problem(404, "service-not-found", "模型服务不存在")
		}
		if input.ExpectedRevision != found.Revision {
			return Profile{}, problem(409, "revision-conflict", "模型服务已被修改，请重新读取后重试")
		}
		if input.Credential == nil {
			stored, _ := s.latest(found.Models[0].ID)
			if stored.Credential != "" && (found.Provider != input.Provider || found.BaseURL != strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")) {
				return Profile{}, problem(400, "discovery-credential-required", "服务地址已修改，请输入 API Key 后再获取模型")
			}
			credential = stored.Credential
		}
	}
	return fromInput(Input{Provider: input.Provider, APIFormat: input.APIFormat, BaseURL: input.BaseURL, Credential: input.Credential, Active: true, Model: "catalog", ContextTokens: 1, OutputTokens: 1, Capabilities: Capabilities{Text: true, Source: "模型目录"}}, credential)
}

func (c *httpClient) ListModels(ctx context.Context, p Profile) ([]DiscoveredModel, error) {
	if ctx == nil {
		return nil, problem(400, "invalid-model-request", "模型请求缺少上下文")
	}
	if err := validateProfile(p); err != nil {
		return nil, err
	}
	base := strings.TrimRight(p.BaseURL, "/")
	anthropic := p.APIFormat == FormatAnthropicMessages && p.Provider != ProviderDeepSeek
	if p.Provider == ProviderDeepSeek {
		// DeepSeek 的目录属于共享 OpenAI 基址，与当前生成协议无关。
		base = strings.TrimSuffix(strings.TrimSuffix(base, "/anthropic/v1"), "/anthropic")
	} else if anthropic && !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return nil, problem(400, "invalid-model-request", "模型请求地址无效")
	}
	req.Header.Set("Accept", "application/json")
	if anthropic {
		req.Header.Set("anthropic-version", "2023-06-01")
		if p.Credential != "" {
			req.Header.Set("x-api-key", p.Credential)
		}
	} else if p.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+p.Credential)
	}
	body, err := c.send(ctx, req)
	if err != nil {
		return nil, err
	}
	if _, err := jsonvalue.Object(body); err != nil {
		return nil, invalidCatalog()
	}
	var wire struct {
		Data []struct {
			ID            string `json:"id"`
			Name          string `json:"name"`
			DisplayName   string `json:"display_name"`
			ContextTokens *int   `json:"context_window"`
			OutputTokens  *int   `json:"max_output_tokens"`
		} `json:"data"`
		HasMore bool `json:"has_more"`
	}
	if json.Unmarshal(body, &wire) != nil || wire.Data == nil || len(wire.Data) > 512 || wire.HasMore {
		return nil, invalidCatalog()
	}
	result := make([]DiscoveredModel, 0, len(wire.Data))
	seen := map[string]bool{}
	for _, row := range wire.Data {
		name := row.Name
		if name == "" {
			name = row.DisplayName
		}
		if name == "" {
			name = row.ID
		}
		if !cleanText(row.ID, 200) || !cleanText(name, 200) || seen[row.ID] {
			return nil, invalidCatalog()
		}
		for _, capacity := range []*int{row.ContextTokens, row.OutputTokens} {
			if capacity != nil && (*capacity < 1 || *capacity > 2_000_000) {
				return nil, invalidCatalog()
			}
		}
		seen[row.ID] = true
		result = append(result, DiscoveredModel{Model: row.ID, Name: name, ContextTokens: row.ContextTokens, OutputTokens: row.OutputTokens})
	}
	return result, nil
}

func invalidCatalog() *Error {
	return problem(502, "invalid-model-catalog", "模型目录格式无效、超出容量或未完整返回，请手动添加模型")
}

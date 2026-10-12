package model

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
)

func newConfigID(prefix string) (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", problem(503, "profile-id-unavailable", "无法分配模型配置编号")
	}
	return prefix + hex.EncodeToString(random[:]), nil
}

// Services 将现有单模型配置也作为独立服务呈现；不会重写任何历史修订。
func (s *Store) Services() []Service {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.servicesLocked()
}

func (s *Store) servicesLocked() []Service {
	latest := map[string]Profile{}
	for _, p := range s.records {
		latest[p.ID] = p
	}
	groups := map[string]*Service{}
	for _, p := range latest {
		if p.Removed {
			continue
		}
		id, revision, name, active, enabled := p.ID, p.Revision, p.Name, p.Active, p.Active
		if p.Service != nil {
			id, revision, name, active, enabled = p.Service.ID, p.Service.Revision, p.Service.Name, p.Service.Active, p.Service.Enabled
		}
		group := groups[id]
		if group == nil {
			group = &Service{ID: id, Revision: revision, Name: name, Provider: p.Provider, APIFormat: p.APIFormat, BaseURL: p.BaseURL, Active: active, HasCredential: p.Credential != "", Models: []ServiceModel{}}
			groups[id] = group
		}
		group.Models = append(group.Models, ServiceModel{Profile: p.Public(), Enabled: enabled})
	}
	result := make([]Service, 0, len(groups))
	for _, group := range groups {
		sort.Slice(group.Models, func(i, j int) bool {
			if group.Models[i].Name != group.Models[j].Name {
				return group.Models[i].Name < group.Models[j].Name
			}
			return group.Models[i].ID < group.Models[j].ID
		})
		result = append(result, *group)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name != result[j].Name {
			return result[i].Name < result[j].Name
		}
		return result[i].ID < result[j].ID
	})
	return result
}

func (s *Store) CreateService(input ServiceInput) (Service, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, err := newConfigID("service-")
	if err != nil {
		return Service{}, err
	}
	return s.saveServiceLocked(id, 1, input, nil)
}

func (s *Store) UpdateService(id string, revision int, input ServiceInput) (Service, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, service := range s.servicesLocked() {
		if service.ID != id {
			continue
		}
		if revision != service.Revision {
			return Service{}, problem(409, "revision-conflict", "模型服务已被修改，请重新读取后重试")
		}
		if revision+1 <= revision {
			return Service{}, problem(409, "revision-limit", "模型服务修订数量达到上限")
		}
		return s.saveServiceLocked(id, revision+1, input, &service)
	}
	return Service{}, problem(404, "service-not-found", "模型服务不存在")
}

// 整组验证及 CAS 在同一锁内完成；新增、编辑、移除模型与共享凭据一次原子写入。
func (s *Store) saveServiceLocked(id string, revision int, input ServiceInput, old *Service) (Service, error) {
	name := strings.TrimSpace(input.Name)
	if !cleanText(name, 120) || len(input.Models) < 1 || len(input.Models) > 64 {
		return Service{}, problem(400, "invalid-service", "请填写服务名称，并配置 1 至 64 个模型")
	}
	oldModels := map[string]Profile{}
	credential := ""
	if old != nil {
		for _, p := range old.Models {
			stored, _ := s.latest(p.ID)
			oldModels[p.ID] = stored
			credential = stored.Credential
		}
	}
	if input.Credential != nil {
		credential = *input.Credential
	}
	// 服务开启时即需要有效 DeepSeek 凭据，与每个模型的开关无关。
	if input.Provider == ProviderDeepSeek && input.Active && strings.TrimSpace(credential) == "" {
		return Service{}, problem(400, "invalid-profile", "启用 DeepSeek 服务前请配置 API Key")
	}
	records := make([]Profile, 0, len(input.Models)+len(oldModels))
	result := Service{ID: id, Revision: revision, Name: name, Provider: input.Provider, APIFormat: input.APIFormat, Active: input.Active, HasCredential: credential != "", Models: []ServiceModel{}}
	seenIDs, seenModels := map[string]bool{}, map[string]bool{}
	for _, row := range input.Models {
		modelName := strings.TrimSpace(row.Model)
		if seenModels[modelName] {
			return Service{}, problem(400, "invalid-service", "同一服务不能重复配置相同模型标识")
		}
		seenModels[modelName] = true
		previous, exists := oldModels[row.ID]
		if row.ID != "" && (!exists || seenIDs[row.ID]) {
			return Service{}, problem(400, "invalid-service", "模型编号不属于当前服务或重复")
		}
		profile, err := fromInput(Input{Provider: input.Provider, APIFormat: input.APIFormat, BaseURL: input.BaseURL, Name: row.Name, Model: modelName, ContextTokens: row.ContextTokens, OutputTokens: row.OutputTokens, Capabilities: row.Capabilities, Active: input.Active && row.Enabled}, credential)
		if err != nil {
			return Service{}, err
		}
		if exists {
			profile.ID, profile.Revision = previous.ID, previous.Revision+1
			if profile.Revision <= previous.Revision {
				return Service{}, problem(409, "revision-limit", "模型修订数量达到上限")
			}
		} else {
			profile.ID, err = newConfigID("model-")
			profile.Revision = 1
			if err != nil {
				return Service{}, err
			}
		}
		seenIDs[profile.ID] = true
		profile.Service = &ServiceRef{ID: id, Revision: revision, Name: name, Active: input.Active, Enabled: row.Enabled}
		records = append(records, profile)
		result.BaseURL = profile.BaseURL
		result.Models = append(result.Models, ServiceModel{Profile: profile.Public(), Enabled: row.Enabled})
	}
	for modelID, previous := range oldModels {
		if seenIDs[modelID] {
			continue
		}
		previous.Revision++
		if previous.Revision <= 0 {
			return Service{}, problem(409, "revision-limit", "模型修订数量达到上限")
		}
		previous.Removed, previous.Active = true, false
		previous.Service = &ServiceRef{ID: id, Revision: revision, Name: name, Active: input.Active, Enabled: false}
		records = append(records, previous)
	}
	if err := s.append(records...); err != nil {
		return Service{}, err
	}
	return result, nil
}

package websites

import (
	"context"
	"encoding/json"
	"time"

	"elysian/server/internal/shared"
)

func (s *websiteService) stageCertificate(ctx context.Context, domain string, material CertificateMaterial) (*WebsiteCertificateRef, error) {
	metadata, err := ValidateWebsiteCertificate(material, domain, s.deps.trustedRoots, time.Now())
	if err != nil {
		return nil, err
	}
	ref, err := s.deps.certificates.Save(ctx, material)
	if err != nil {
		return nil, err
	}
	return &WebsiteCertificateRef{Ref: ref, Issuer: metadata.Issuer, NotAfter: metadata.NotAfter, Fingerprint256: metadata.Fingerprint256}, nil
}

func (s *websiteService) applyAccessToProxy(ctx context.Context, before, after []WebsiteRecord) (json.RawMessage, any, error) {
	currentRaw, cerr := s.deps.caddy.CurrentConfig(ctx)
	if cerr != nil {
		return nil, nil, cerr
	}
	if HasForeignConfig(parseJSONValue(currentRaw), expectedProxyHosts(before), s.deps.caddy.AdminListen()) {
		return nil, nil, shared.Conflict("宿主 Caddy 存在面板外的配置，拒绝覆盖")
	}
	sites, err := s.sitesWithCertificates(ctx, after)
	if err != nil {
		return nil, nil, err
	}
	configBytes := BuildCaddyConfig(sites, s.deps.caddy.AdminListen())
	config := parseJSONValue(configBytes)
	if err := s.deps.caddy.Load(ctx, configBytes); err != nil {
		return nil, nil, err
	}
	return currentRaw, config, nil
}

// 返回旧容器是否已停止，供调用方在后续失败时按原流程恢复。
func (s *websiteService) swapContainer(ctx context.Context, previous, next string) (bool, error) {
	if err := s.deps.docker.Stop(ctx, previous); err != nil {
		return false, err
	}
	return true, s.deps.docker.Start(ctx, next)
}

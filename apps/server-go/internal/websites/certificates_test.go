package websites

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 用户证书校验与存储（websitesCertificates.test.ts 4 例的 Go 对等）。

func TestValidateCertificateAcceptsFullChain(t *testing.T) {
	chain := makeTestChain(t)
	metadata, err := ValidateWebsiteCertificate(
		CertificateMaterial{CertificatePEM: chain.CertificatePEM, PrivateKeyPEM: chain.PrivateKeyPEM},
		"example.com", parseTrustedRoots(t, chain.RootPEM), time.Time{})
	if err != nil {
		t.Fatalf("完整链应通过：%v", err)
	}
	if !strings.Contains(metadata.Issuer, "Test Intermediate") {
		t.Fatalf("issuer 应含中间 CA 名，得到 %q", metadata.Issuer)
	}
	if len(metadata.Fingerprint256) != 95 || !strings.Contains(metadata.Fingerprint256, ":") {
		t.Fatalf("指纹应为冒号分隔大写 hex（SHA-256 共 32 字节），得到 %q", metadata.Fingerprint256)
	}
	if strings.Contains(metadata.Issuer+metadata.NotAfter+metadata.Fingerprint256, "PRIVATE KEY") {
		t.Fatalf("元数据不得含私钥痕迹")
	}
}

func TestValidateCertificateRejections(t *testing.T) {
	chain := makeTestChain(t)
	roots := parseTrustedRoots(t, chain.RootPEM)
	material := CertificateMaterial{CertificatePEM: chain.CertificatePEM, PrivateKeyPEM: chain.PrivateKeyPEM}
	if _, err := ValidateWebsiteCertificate(material, "other.example.com", roots, time.Time{}); err == nil || err.Error() != "证书 SAN 未覆盖域名" {
		t.Fatalf("错域名应拒绝，得到 %v", err)
	}
	wrongKey := CertificateMaterial{CertificatePEM: chain.CertificatePEM, PrivateKeyPEM: chain.OtherKeyPEM}
	if _, err := ValidateWebsiteCertificate(wrongKey, "example.com", roots, time.Time{}); err == nil || err.Error() != "证书与私钥不匹配" {
		t.Fatalf("错私钥应拒绝，得到 %v", err)
	}
	missingIntermediate := CertificateMaterial{CertificatePEM: chain.LeafPEM, PrivateKeyPEM: chain.PrivateKeyPEM}
	if _, err := ValidateWebsiteCertificate(missingIntermediate, "example.com", roots, time.Time{}); err == nil || err.Error() != "证书链未能验证到公开可信根，请上传完整证书链" {
		t.Fatalf("缺中间证书应拒绝，得到 %v", err)
	}
	if _, err := ValidateWebsiteCertificate(material, "example.com", nil, time.Time{}); err == nil || !strings.Contains(err.Error(), "公开可信根") {
		t.Fatalf("空根表（私有 CA）应拒绝，得到 %v", err)
	}
	expired := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := ValidateWebsiteCertificate(material, "example.com", roots, expired); err == nil || err.Error() != "证书链存在未生效或已过期证书" {
		t.Fatalf("过期应拒绝，得到 %v", err)
	}
	if _, err := ValidateWebsiteCertificate(CertificateMaterial{CertificatePEM: "not a pem", PrivateKeyPEM: "x"}, "example.com", roots, time.Time{}); err == nil || err.Error() != "证书或私钥格式无效" {
		t.Fatalf("坏格式应拒绝，得到 %v", err)
	}
}

func TestValidateCertificateRejectsSelfSigned(t *testing.T) {
	selfSigned := makeSelfSignedTestCertificate(t)
	if _, err := ValidateWebsiteCertificate(selfSigned, "example.com", nil, time.Time{}); err == nil || !strings.Contains(err.Error(), "公开可信根") {
		t.Fatalf("自签名应拒绝，得到 %v", err)
	}
}

func TestMemoryCertificateStoreRefOnly(t *testing.T) {
	store := NewMemoryWebsiteCertificateStore()
	material := CertificateMaterial{CertificatePEM: "cert", PrivateKeyPEM: "secret"}
	ref, err := store.Save(context.Background(), material)
	if err != nil {
		t.Fatalf("save 失败：%v", err)
	}
	if strings.Contains(ref, "secret") {
		t.Fatalf("引用不得含材料")
	}
	read, err := store.Read(context.Background(), ref)
	if err != nil || read != material {
		t.Fatalf("read 应返回原材料：%v", err)
	}
	if err := store.Remove(context.Background(), ref); err != nil {
		t.Fatalf("remove 失败：%v", err)
	}
	if _, err := store.Read(context.Background(), ref); err == nil || err.Error() != "证书文件不存在" {
		t.Fatalf("移除后应报不存在，得到 %v", err)
	}
}

func TestFileCertificateStore(t *testing.T) {
	store := NewFileWebsiteCertificateStore(filepath.Join(t.TempDir(), "website-certificates"))
	ctx := context.Background()
	material := CertificateMaterial{CertificatePEM: "cert", PrivateKeyPEM: "secret"}
	ref, err := store.Save(ctx, material)
	if err != nil {
		t.Fatalf("save 失败：%v", err)
	}
	read, err := store.Read(ctx, ref)
	if err != nil || read != material {
		t.Fatalf("read 应返回原材料：%v", err)
	}
	if err := store.Remove(ctx, ref); err != nil {
		t.Fatalf("remove 失败：%v", err)
	}
	// 再删一次（ENOENT 吞掉）不报错。
	if err := store.Remove(ctx, ref); err != nil {
		t.Fatalf("重复 remove 应幂等：%v", err)
	}
	if _, err := store.Read(ctx, ref); err == nil {
		t.Fatalf("移除后 read 应失败")
	}
	if _, err := store.Read(ctx, "bad ref"); err == nil || err.Error() != "证书引用无效" {
		t.Fatalf("非法引用应报错，得到 %v", err)
	}
}

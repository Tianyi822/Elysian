package websites

import (
	"crypto/x509"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

/*
 * 测试专用临时 CA（websitesCertificateTestUtils.ts 的 Go 版）：openssl 参数数组不经
 * shell；工具链缺失时跳过（门禁镜像随 ca-certificates 提供 openssl）。
 */

// testChain 一条 root→intermediate→leaf 测试链的全部材料。
type testChain struct {
	CertificatePEM  string // leaf + intermediate
	PrivateKeyPEM   string // leaf 私钥
	RootPEM         string
	LeafPEM         string
	IntermediatePEM string
	OtherKeyPEM     string // root 私钥（错私钥用例）
}

func runOpenSSL(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("openssl", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("openssl %s 失败：%v\n%s", strings.Join(args, " "), err, output)
	}
}

func readTestFile(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("读取测试文件 %s 失败：%v", name, err)
	}
	return string(data)
}

// makeTestChain 生成测试链；openssl 不可用时跳过测试。
func makeTestChain(t *testing.T) testChain {
	t.Helper()
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl 不可用，跳过证书链测试")
	}
	dir := t.TempDir()
	domain := "example.com"
	runOpenSSL(t, dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.crt", "-days", "365", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=keyCertSign,cRLSign")
	runOpenSSL(t, dir, "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "intermediate.key", "-out", "intermediate.csr", "-subj", "/CN=Test Intermediate")
	if err := os.WriteFile(filepath.Join(dir, "intermediate.ext"), []byte("basicConstraints=critical,CA:TRUE\nkeyUsage=keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n"), 0o600); err != nil {
		t.Fatalf("写 intermediate.ext 失败：%v", err)
	}
	runOpenSSL(t, dir, "x509", "-req", "-in", "intermediate.csr", "-CA", "root.crt", "-CAkey", "root.key", "-CAcreateserial", "-out", "intermediate.crt", "-days", "300", "-extfile", "intermediate.ext")
	runOpenSSL(t, dir, "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", fmt.Sprintf("/CN=%s", domain))
	if err := os.WriteFile(filepath.Join(dir, "leaf.ext"), []byte(fmt.Sprintf("basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:%s\nauthorityKeyIdentifier=keyid,issuer\n", domain)), 0o600); err != nil {
		t.Fatalf("写 leaf.ext 失败：%v", err)
	}
	runOpenSSL(t, dir, "x509", "-req", "-in", "leaf.csr", "-CA", "intermediate.crt", "-CAkey", "intermediate.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "90", "-extfile", "leaf.ext")
	return testChain{
		CertificatePEM:  readTestFile(t, dir, "leaf.crt") + readTestFile(t, dir, "intermediate.crt"),
		PrivateKeyPEM:   readTestFile(t, dir, "leaf.key"),
		RootPEM:         readTestFile(t, dir, "root.crt"),
		LeafPEM:         readTestFile(t, dir, "leaf.crt"),
		IntermediatePEM: readTestFile(t, dir, "intermediate.crt"),
		OtherKeyPEM:     readTestFile(t, dir, "root.key"),
	}
}

// makeSelfSignedTestCertificate 生成自签名站点证书（必须被拒）。
func makeSelfSignedTestCertificate(t *testing.T) CertificateMaterial {
	t.Helper()
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl 不可用，跳过证书链测试")
	}
	dir := t.TempDir()
	domain := "example.com"
	runOpenSSL(t, dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.crt", "-days", "30", "-subj", fmt.Sprintf("/CN=%s", domain), "-addext", fmt.Sprintf("subjectAltName=DNS:%s", domain), "-addext", "basicConstraints=critical,CA:FALSE")
	return CertificateMaterial{CertificatePEM: readTestFile(t, dir, "leaf.crt"), PrivateKeyPEM: readTestFile(t, dir, "leaf.key")}
}

// parseTrustedRoots 把受信根 PEM 解析为校验函数入参。
func parseTrustedRoots(t *testing.T, pems ...string) []*x509.Certificate {
	t.Helper()
	roots := make([]*x509.Certificate, 0, len(pems))
	for _, pem := range pems {
		parsed, ok := parseCertificatePEM(pem)
		if !ok || len(parsed) == 0 {
			t.Fatalf("受信根 PEM 解析失败")
		}
		roots = append(roots, parsed...)
	}
	return roots
}

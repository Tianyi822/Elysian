package websites

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/shared"
)

/*
 * 用户证书校验与存储（websitesCertificates.ts 逐字移植）：只接受能沿上传链验证到
 * 公开可信根的证书，私有 CA 与自签名一律拒绝；存储只落证书文件（0600），登记只存
 * 引用与公开元数据。
 */

// 体积上限：证书链 96 KiB、私钥 32 KiB（UTF-16 code unit 口径，PEM 为 ASCII 时与
// 字节数一致）。
const (
	certificatePemMaxUnits = 96 * 1024
	privateKeyPemMaxUnits  = 32 * 1024
)

// CertificateMaterial 一次上传的证书链与私钥材料。
type CertificateMaterial struct {
	CertificatePEM string
	PrivateKeyPEM  string
}

// CertificateStore 证书材料存储：save 返回随机引用，read/remove 按引用操作。
type CertificateStore interface {
	Save(ctx context.Context, material CertificateMaterial) (string, error)
	Read(ctx context.Context, ref string) (CertificateMaterial, error)
	Remove(ctx context.Context, ref string) error
}

// CertificateMetadata 校验通过后的公开元数据（不回传任何私钥材料）。
type CertificateMetadata struct {
	Issuer         string
	NotAfter       string
	Fingerprint256 string
}

var pemCertificateBlock = regexp.MustCompile(`(?s)-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----`)

// certificateReferencePattern 证书引用形态。
var certificateReferencePattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)

// errInvalidKeyMaterial 块解析/私钥解析失败的固定 400 文案。
func errInvalidKeyMaterial() error { return shared.InvalidRequest("证书或私钥格式无效") }

// systemRootsOnce 系统受信根懒加载（rootCertificates 的 Go 等价物：容器内为
// /etc/ssl/certs 下发行版证书束）。
var (
	systemRootsOnce sync.Once
	systemRoots     []*x509.Certificate
)

var systemRootBundlePaths = []string{
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/ssl/cert.pem",
}

// loadSystemRoots 读取系统受信根；读取失败回空表（一切链都将按「未验证到公开可信根」
// 拒绝，fail-closed）。
func loadSystemRoots() []*x509.Certificate {
	systemRootsOnce.Do(func() {
		for _, path := range systemRootBundlePaths {
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			roots, ok := parseCertificatePEM(string(data))
			if !ok || len(roots) == 0 {
				continue
			}
			systemRoots = roots
			return
		}
	})
	return systemRoots
}

// ValidateWebsiteCertificate 校验证书材料能否服务给定域名：
// 体积上限 → 纯 CERTIFICATE 块序列 + 私钥可解析且与叶证书匹配 → SAN 覆盖域名 →
// 链上全部证书在有效期内 → 沿链验证到受信根（指纹命中即成功；每步按「CA 位 +
// 签发者名匹配 + 签名验证」找下一环）。now 为零值时取当前时刻。
func ValidateWebsiteCertificate(material CertificateMaterial, domain string, trustedRoots []*x509.Certificate, now time.Time) (CertificateMetadata, error) {
	if utf16Length(material.CertificatePEM) > certificatePemMaxUnits || utf16Length(material.PrivateKeyPEM) > privateKeyPemMaxUnits {
		return CertificateMetadata{}, shared.InvalidRequest("证书文件过大")
	}
	if now.IsZero() {
		now = time.Now()
	}
	if trustedRoots == nil {
		trustedRoots = loadSystemRoots()
	}
	chain, key, err := parseChainAndKey(material)
	if err != nil {
		return CertificateMetadata{}, err
	}
	leaf := chain[0]
	if !publicKeysEqual(leaf.PublicKey, key) {
		return CertificateMetadata{}, shared.InvalidRequest("证书与私钥不匹配")
	}
	if err := leaf.VerifyHostname(domain); err != nil {
		return CertificateMetadata{}, shared.InvalidRequest("证书 SAN 未覆盖域名")
	}
	for _, certificate := range chain {
		// 半开区间 [validFrom, validTo)：过期一瞬即拒绝。
		if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) {
			return CertificateMetadata{}, shared.InvalidRequest("证书链存在未生效或已过期证书")
		}
	}
	leafFingerprint := certificateFingerprint256(leaf)
	publicRoots := trustedRoots
	rootByFingerprint := map[string]struct{}{}
	for _, root := range publicRoots {
		rootByFingerprint[certificateFingerprint256(root)] = struct{}{}
	}
	current := leaf
	seen := map[string]struct{}{}
	for depth := 0; depth <= len(chain); depth++ {
		fingerprint := certificateFingerprint256(current)
		if _, cycle := seen[fingerprint]; cycle {
			return CertificateMetadata{}, shared.InvalidRequest("证书链存在循环")
		}
		seen[fingerprint] = struct{}{}
		if _, isRoot := rootByFingerprint[fingerprint]; isRoot {
			return CertificateMetadata{
				Issuer:         leaf.Issuer.String(),
				NotAfter:       leaf.NotAfter.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
				Fingerprint256: leafFingerprint,
			}, nil
		}
		candidate := findChainIssuer(current, chain[1:], publicRoots)
		if candidate == nil {
			return CertificateMetadata{}, shared.InvalidRequest("证书链未能验证到公开可信根，请上传完整证书链")
		}
		current = candidate
	}
	return CertificateMetadata{}, shared.InvalidRequest("证书链未能验证到公开可信根")
}

// parseChainAndKey 解析证书块序列与私钥：块外残留非空白、块解析失败或私钥不可解析
// 一律「证书或私钥格式无效」。返回私钥对应的公钥（供与叶证书 SubjectPublicKeyInfo
// 比对，等价 TS checkPrivateKey）。
func parseChainAndKey(material CertificateMaterial) ([]*x509.Certificate, crypto.PublicKey, error) {
	blocks := pemCertificateBlock.FindAllString(material.CertificatePEM, -1)
	if len(blocks) == 0 {
		return nil, nil, errInvalidKeyMaterial()
	}
	remainder := pemCertificateBlock.ReplaceAllString(material.CertificatePEM, "")
	if strings.TrimSpace(remainder) != "" {
		return nil, nil, errInvalidKeyMaterial()
	}
	chain := make([]*x509.Certificate, 0, len(blocks))
	for _, block := range blocks {
		decoded, _ := pem.Decode([]byte(block))
		if decoded == nil {
			return nil, nil, errInvalidKeyMaterial()
		}
		certificate, err := x509.ParseCertificate(decoded.Bytes)
		if err != nil {
			return nil, nil, errInvalidKeyMaterial()
		}
		chain = append(chain, certificate)
	}
	key, err := parsePrivateKeyPEM(material.PrivateKeyPEM)
	if err != nil {
		return nil, nil, err
	}
	return chain, key, nil
}

// parsePrivateKeyPEM 解析 PKCS#8 / PKCS#1 / SEC1 形态的 PEM 私钥并取出公钥部分。
func parsePrivateKeyPEM(pemText string) (crypto.PublicKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errInvalidKeyMaterial()
	}
	var key crypto.PrivateKey
	var err error
	switch block.Type {
	case "PRIVATE KEY":
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		key, err = x509.ParseECPrivateKey(block.Bytes)
	default:
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	}
	if err != nil {
		return nil, errInvalidKeyMaterial()
	}
	switch k := key.(type) {
	case *rsa.PrivateKey:
		return &k.PublicKey, nil
	case *ecdsa.PrivateKey:
		return &k.PublicKey, nil
	case ed25519.PrivateKey:
		return k.Public(), nil
	default:
		return nil, errInvalidKeyMaterial()
	}
}

// findChainIssuer 在链内其余项与公开根里找「CA 位 + 签发者名匹配 + 签名验证」通过的
// 上一环（TS checkIssued + verify 的等价组合）。
func findChainIssuer(current *x509.Certificate, chainRest []*x509.Certificate, roots []*x509.Certificate) *x509.Certificate {
	for _, candidates := range [2][]*x509.Certificate{chainRest, roots} {
		for _, candidate := range candidates {
			if candidate.IsCA && bytes.Equal(current.RawIssuer, candidate.RawSubject) && current.CheckSignatureFrom(candidate) == nil {
				return candidate
			}
		}
	}
	return nil
}

// publicKeysEqual 比较两个公钥是否同一把（经 SPKI 编码比对）。
func publicKeysEqual(a, b crypto.PublicKey) bool {
	aDER, err := x509.MarshalPKIXPublicKey(a)
	if err != nil {
		return false
	}
	bDER, err := x509.MarshalPKIXPublicKey(b)
	if err != nil {
		return false
	}
	return bytes.Equal(aDER, bDER)
}

// certificateFingerprint256 冒号分隔的大写 SHA-256 指纹（X509Certificate.
// fingerprint256 的 Go 等价物）。
func certificateFingerprint256(certificate *x509.Certificate) string {
	digest := sha256.Sum256(certificate.Raw)
	parts := make([]string, len(digest))
	for i, b := range digest {
		parts[i] = strings.ToUpper(hex.EncodeToString([]byte{b}))
	}
	return strings.Join(parts, ":")
}

// parseCertificatePEM 把含若干 CERTIFICATE 块的文本解析为证书列表；任一块无效整体失败。
func parseCertificatePEM(text string) ([]*x509.Certificate, bool) {
	blocks := pemCertificateBlock.FindAllString(text, -1)
	if len(blocks) == 0 {
		return nil, false
	}
	certificates := make([]*x509.Certificate, 0, len(blocks))
	for _, block := range blocks {
		decoded, _ := pem.Decode([]byte(block))
		if decoded == nil {
			return nil, false
		}
		certificate, err := x509.ParseCertificate(decoded.Bytes)
		if err != nil {
			return nil, false
		}
		certificates = append(certificates, certificate)
	}
	return certificates, true
}

// NewFileWebsiteCertificateStore 文件版证书存储：目录缺省 ~/.Elysian/config/website-certificates。
func NewFileWebsiteCertificateStore(directory string) CertificateStore {
	return &fileWebsiteCertificateStore{directory: directory}
}

type fileWebsiteCertificateStore struct {
	directory string
}

func (s *fileWebsiteCertificateStore) pathFor(ref string) (string, error) {
	if !certificateReferencePattern.MatchString(ref) {
		return "", shared.InvalidRequest("证书引用无效")
	}
	return s.directory + "/" + ref + ".json", nil
}

// Save mkdir 0700 后以独占方式写 0600 材料文件并 fsync（TS `wx` + sync 等价物）。
func (s *fileWebsiteCertificateStore) Save(_ context.Context, material CertificateMaterial) (string, error) {
	if err := os.MkdirAll(s.directory, 0o700); err != nil {
		return "", err
	}
	ref := randomUUID()
	path, err := s.pathFor(ref)
	if err != nil {
		return "", err
	}
	data, err := marshalJSONCompact(material)
	if err != nil {
		return "", err
	}
	handle, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := handle.Write(data); err != nil {
		_ = handle.Close()
		return "", err
	}
	if err := handle.Sync(); err != nil {
		_ = handle.Close()
		return "", err
	}
	if err := handle.Close(); err != nil {
		return "", err
	}
	return ref, nil
}

func (s *fileWebsiteCertificateStore) Read(_ context.Context, ref string) (CertificateMaterial, error) {
	path, err := s.pathFor(ref)
	if err != nil {
		return CertificateMaterial{}, err
	}
	handle, err := openNoFollow(path)
	if err != nil {
		return CertificateMaterial{}, err
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return CertificateMaterial{}, err
	}
	if !statTrusted(info, certificateFileMaxBytes) {
		return CertificateMaterial{}, errCertificateFileUnusable
	}
	data, err := readAll(handle)
	if err != nil {
		return CertificateMaterial{}, err
	}
	var value struct {
		CertificatePem *string `json:"certificatePem"`
		PrivateKeyPem  *string `json:"privateKeyPem"`
	}
	if err := json.Unmarshal(data, &value); err != nil {
		return CertificateMaterial{}, err
	}
	if value.CertificatePem == nil || value.PrivateKeyPem == nil {
		return CertificateMaterial{}, errCertificateFileInvalid
	}
	return CertificateMaterial{CertificatePEM: *value.CertificatePem, PrivateKeyPEM: *value.PrivateKeyPem}, nil
}

func (s *fileWebsiteCertificateStore) Remove(_ context.Context, ref string) error {
	path, err := s.pathFor(ref)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !isENOENT(err) {
		return err
	}
	return nil
}

// NewMemoryWebsiteCertificateStore 内存版证书存储（测试/缺省装配用）。
func NewMemoryWebsiteCertificateStore() *memoryCertificateStore {
	return &memoryCertificateStore{records: map[string]CertificateMaterial{}}
}

type memoryCertificateStore struct {
	mu      sync.Mutex
	records map[string]CertificateMaterial
}

func (s *memoryCertificateStore) Save(_ context.Context, material CertificateMaterial) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ref := randomUUID()
	s.records[ref] = material
	return ref, nil
}

func (s *memoryCertificateStore) Read(_ context.Context, ref string) (CertificateMaterial, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	material, ok := s.records[ref]
	if !ok {
		return CertificateMaterial{}, errCertificateMissing
	}
	return material, nil
}

func (s *memoryCertificateStore) Remove(_ context.Context, ref string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, ref)
	return nil
}

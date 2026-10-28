package docker

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// 显式开启的真实验收：在 go-dev 中挂载 Engine socket 并设置所选源。
// 只清理由该用例新建的精确标签，不按镜像 ID 删除已有标签。
func TestRealEngineImagePull(t *testing.T) {
	registry := os.Getenv("ELYSIAN_TEST_IMAGE_PULL_REGISTRY")
	if registry == "" {
		t.Skip("设置 ELYSIAN_TEST_IMAGE_PULL_REGISTRY 后执行真实镜像拉取验收")
	}
	service := newDockerService(serviceDeps{transport: newUnixTransport("/var/run/docker.sock")})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	const name, tag = "redis", "7-alpine"
	referenceExists := func(ref string) (bool, error) {
		status, _, err := service.engineJSON(ctx, http.MethodGet, "/images/"+encodeEngineID(ref)+"/json", nil, nil, actionTimeout)
		if err != nil {
			return false, err
		}
		if status != http.StatusOK && status != http.StatusNotFound {
			return false, fmt.Errorf("核对验收镜像失败（HTTP %d）", status)
		}
		return status == http.StatusOK, nil
	}
	exists, err := referenceExists(name + ":" + tag)
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Skip("验收镜像已存在，保留现有镜像；请在未缓存 redis:7-alpine 的测试 Engine 执行")
	}
	host := strings.TrimRight(strings.TrimPrefix(registry, "https://"), "/")
	sourceRef := buildRegistryFromImage(host, name, tag)
	// 源标签可能先于目标标签存在，不能将它当成本用例产物清理。
	sourceExists, err := referenceExists(sourceRef)
	if err != nil {
		t.Fatal(err)
	}
	if sourceExists {
		t.Skip("验收源标签已存在，保留现有镜像")
	}
	t.Cleanup(func() {
		cleanupCtx, stop := context.WithTimeout(context.Background(), time.Minute)
		defer stop()
		for _, ref := range []string{name + ":" + tag, sourceRef} {
			result, err := service.deleteImageRef(cleanupCtx, ref)
			if err != nil {
				t.Logf("验收标签 %s 清理失败：%v", ref, err)
			} else if result.message != "" && !strings.Contains(result.message, "No such image") {
				t.Logf("验收标签 %s 清理结果：%s", ref, result.message)
			}
		}
	})
	downloaded := false
	lastPhase := ""
	image, err := service.Pull(ctx, mustDecode(t, `{"name":"redis","tag":"7-alpine","registry":"`+registry+`"}`), func(progress imagePullProgress) {
		if progress.Phase == "downloading" {
			downloaded = true
		}
		if key := progress.Phase + progress.Message; key != lastPhase {
			t.Logf("真实进度：%s %s", progress.Phase, progress.Message)
			lastPhase = key
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if !downloaded || image.Name != name || image.Tag != tag || image.ID == "" {
		t.Fatalf("未完成下载和目标标签回读：downloaded=%v image=%+v", downloaded, image)
	}
	remaining, err := referenceExists(sourceRef)
	if err != nil || remaining {
		t.Fatalf("源标签未清理：exists=%v err=%v", remaining, err)
	}
	t.Logf("真实拉取成功：%s:%s %s", image.Name, image.Tag, image.Digest)
}

package panel

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	sourceCheckAttemptTimeout    = 8 * time.Second
	sourceHistoryAttemptTimeout  = 10 * time.Second
	sourceDownloadAttemptTimeout = 5 * time.Minute
)

// FallbackSource 先使用 GitHub，网络或接口失败时再尝试 Gitee 镜像。
// 两个来源必须返回同一仓库语义；Gitee 镜像由仓库所有者维护。
type FallbackSource struct {
	Primary  Source
	Fallback Source
}

func (s FallbackSource) sources() (Source, Source) {
	primary, fallback := s.Primary, s.Fallback
	if primary == nil {
		primary = GitHubSource{}
	}
	if fallback == nil {
		fallback = GiteeSource{}
	}
	return primary, fallback
}

func (s FallbackSource) Check(ctx context.Context, channel UpdateChannel) (Update, error) {
	primary, fallback := s.sources()
	primaryCtx, cancel := context.WithTimeout(ctx, sourceCheckAttemptTimeout)
	u, err := primary.Check(primaryCtx, channel)
	cancel()
	if err == nil {
		return u, nil
	}
	if ctx.Err() != nil {
		return u, err
	}
	fallbackCtx, cancel := context.WithTimeout(ctx, sourceCheckAttemptTimeout)
	u2, err2 := fallback.Check(fallbackCtx, channel)
	cancel()
	if err2 != nil {
		return u, fmt.Errorf("GitHub 更新检查失败：%v；Gitee 回退失败：%w", err, err2)
	}
	if normalizeChannel(channel) == ChannelRelease && u2.ReleaseTag == "" {
		return u, fmt.Errorf("GitHub 更新检查失败：%v；Gitee 镜像暂无正式发版", err)
	}
	return u2, nil
}

func (s FallbackSource) History(ctx context.Context, channel UpdateChannel, limit int) ([]CommitLog, error) {
	primary, fallback := s.sources()
	primaryCtx, cancel := context.WithTimeout(ctx, sourceHistoryAttemptTimeout)
	commits, err := primary.History(primaryCtx, channel, limit)
	cancel()
	if err == nil {
		return commits, nil
	}
	if ctx.Err() != nil {
		return commits, err
	}
	fallbackCtx, cancel := context.WithTimeout(ctx, sourceHistoryAttemptTimeout)
	commits, err2 := fallback.History(fallbackCtx, channel, limit)
	cancel()
	if err2 != nil {
		return nil, fmt.Errorf("GitHub 更新日志读取失败：%v；Gitee 回退失败：%w", err, err2)
	}
	return commits, nil
}

func (s FallbackSource) Download(ctx context.Context, sha, destination string) error {
	primary, fallback := s.sources()
	primaryCtx, cancel := context.WithTimeout(ctx, sourceDownloadAttemptTimeout)
	err := primary.Download(primaryCtx, sha, destination)
	cancel()
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return err
	}
	if destination == "" || filepath.Clean(destination) == "." || filepath.Clean(destination) == string(filepath.Separator) {
		return fmt.Errorf("GitHub 源码下载失败：%v；源码目标目录无效", err)
	}
	if cleanErr := os.RemoveAll(destination); cleanErr != nil {
		return fmt.Errorf("GitHub 源码下载失败：%v；清理部分下载失败：%w", err, cleanErr)
	}
	if mkdirErr := os.MkdirAll(destination, 0700); mkdirErr != nil {
		return fmt.Errorf("Gitee 回退准备目录失败：%w", mkdirErr)
	}
	fallbackCtx, cancel := context.WithTimeout(ctx, sourceDownloadAttemptTimeout)
	err2 := fallback.Download(fallbackCtx, sha, destination)
	cancel()
	if err2 == nil {
		return nil
	}
	return fmt.Errorf("GitHub 源码下载失败：%v；Gitee 回退失败：%w", err, err2)
}

func DefaultSource() Source {
	return FallbackSource{Primary: GitHubSource{}, Fallback: GiteeSource{}}
}

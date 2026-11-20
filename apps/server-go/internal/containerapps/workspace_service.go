package containerapps

import (
	"context"
	"errors"
	"io"

	"elysian/server/internal/shared"
)

type workspaceService struct {
	registry *Registry
	builds   *BuildManager
}

// resolvePath 先解析工作区目录，再校验工作区内的相对路径。
func (s workspaceService) resolvePath(slug, path string) (string, string, error) {
	if err := ValidateSlug(slug); err != nil {
		return "", "", badRequest(err)
	}
	dir, err := s.registry.Directory(slug)
	if err != nil {
		return "", "", err
	}
	rel, err := NormalizeRelative(path)
	if err != nil {
		return "", "", badRequest(err)
	}
	return dir, rel, nil
}

func (s workspaceService) lockEditable(ctx context.Context, slug string) (func(), error) {
	release, err := s.registry.LockWorkspace(ctx, slug)
	if err != nil {
		return nil, err
	}
	if s.builds != nil && s.builds.HasActive(slug) {
		release()
		return nil, shared.Conflict("工作区有进行中的构建任务，请先取消或等待完成")
	}
	return release, nil
}

func (s workspaceService) removeLocked(slug string) error {
	// 工作区有进行中的构建任务时拒绝删除：任务还引用着目录里的上下文。
	if s.builds != nil && s.builds.HasActive(slug) {
		return shared.Conflict("工作区有进行中的构建任务，请先取消或等待完成")
	}
	if err := s.registry.Delete(slug); err != nil {
		return err
	}
	// 删除成功后清残留活跃任务：并发窗口内已开跑的任务直接落 failed 终态并停流，
	// 窗口内更晚创建的任务由打包阶段自然失败，不做联合锁。
	if s.builds != nil {
		s.builds.InterruptActive(slug, workspaceDeletedMessage)
	}
	return nil
}

func writeWorkspaceText(dir, rel string, reader io.Reader) (FileEntry, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maxTextBytes+1))
	if err != nil {
		return FileEntry{}, err
	}
	if int64(len(body)) > maxTextBytes {
		return FileEntry{}, &TooLargeError{Limit: maxTextBytes}
	}
	return WriteContent(dir, rel, string(body))
}

func (s workspaceService) checkCompose(slug, path string) (CheckResult, error) {
	dir, rel, err := s.resolvePath(slug, path)
	if err != nil {
		return CheckResult{}, err
	}
	content, _, err := ReadContent(dir, rel)
	if err != nil {
		return CheckResult{}, err
	}
	result, err := CheckCompose(dir, rel, content)
	if err != nil {
		return CheckResult{}, badRequest(err)
	}
	return result, nil
}

// badRequest 把输入校验类错误统一成 400，避免用户写错路径却收到 500；带状态码的
// 错误（文件不存在等）原样透传，由 writeError 映射。
func badRequest(err error) error {
	if err == nil {
		return nil
	}
	var invalid *shared.InvalidRequestError
	var fileNotFound *FileNotFoundError
	if errors.As(err, &invalid) || errors.As(err, &fileNotFound) {
		return err
	}
	return shared.InvalidRequest(err.Error())
}

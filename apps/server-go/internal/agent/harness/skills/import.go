package skills

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func validateInput(input ImportInput) error {
	if !requestPattern.MatchString(input.RequestID) {
		return problem(400, "invalid-request-id", "请求标识必须为 1 到 128 位字母、数字或 ._:-")
	}
	if (input.SkillID == "" && input.ExpectedRevision != 0) || (input.SkillID != "" && (!skillIDPattern.MatchString(input.SkillID) || input.ExpectedRevision < 1)) {
		return problem(400, "invalid-skill-revision", "技能更新必须指定有效编号和预期修订")
	}
	source := input.Source
	if source.Commit != "" {
		return problem(400, "invalid-source", "Git commit 由导入服务解析，不接受调用者预填")
	}
	if source.Subdirectory != "" {
		if _, err := cleanRelative(source.Subdirectory); err != nil {
			return err
		}
	}
	switch source.Kind {
	case "directory":
		if !filepath.IsAbs(source.Path) || source.URL != "" || source.Ref != "" || input.Credential != "" {
			return problem(400, "invalid-source", "本地技能来源必须为绝对目录且不包含 Git 配置")
		}
	case "zip":
		if source.Path != "" || source.URL != "" || source.Ref != "" || source.Subdirectory != "" || input.Credential != "" {
			return problem(400, "invalid-source", "ZIP 技能来源只接受上传内容")
		}
	case "git":
		parsed, err := url.Parse(source.URL)
		if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || source.Path != "" || len(source.URL) > 2048 {
			return problem(400, "invalid-git-url", "Git 来源必须为不含凭据、查询参数或片段的 HTTPS 地址")
		}
		if source.Ref == "" || len(source.Ref) > 256 || strings.HasPrefix(source.Ref, "-") || strings.ContainsAny(source.Ref, " \t\r\n\x00~^:?*[\\") || strings.Contains(source.Ref, "..") || strings.Contains(source.Ref, "@{") {
			return problem(400, "invalid-git-ref", "Git 来源必须指定有效分支、标签或提交")
		}
		if strings.ContainsAny(input.Credential, "\r\n\x00") || len(input.Credential) > 8192 {
			return problem(400, "invalid-credential", "Git 凭据格式无效")
		}
	default:
		return problem(400, "invalid-source", "技能来源仅支持 directory、zip 或 git")
	}
	return nil
}

func (s *Store) runImport(ctx context.Context, id, stage, credential string) {
	defer s.wg.Done()
	defer os.RemoveAll(stage)
	defer func() {
		if recover() != nil {
			s.finishImport(id, nil, problem(500, "import-failed", "技能导入异常终止"))
		}
	}()
	defer func() {
		s.mu.Lock()
		if cancel := s.cancel[id]; cancel != nil {
			cancel()
			delete(s.cancel, id)
		}
		s.mu.Unlock()
	}()
	select {
	case s.slot <- struct{}{}:
		defer func() { <-s.slot }()
	case <-ctx.Done():
		s.finishImport(id, nil, ctx.Err())
		return
	}
	s.mu.Lock()
	var input ImportInput
	found := false
	next := clone(s.doc)
	for i := range next.Imports {
		task := &next.Imports[i]
		if task.ID == id {
			if task.State != StateQueued || task.CancelRequestedAt != "" {
				s.mu.Unlock()
				return
			}
			input = task.Input
			task.State = StateRunning
			task.StartedAt = s.stamp()
			found = true
			break
		}
	}
	if !found || s.closed || s.unavailable {
		s.mu.Unlock()
		s.finishImport(id, nil, context.Canceled)
		return
	}
	if err := s.save(next); err != nil {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		s.finishImport(id, nil, err)
		return
	}
	destination := filepath.Join(stage, "package")
	dir, err := openDirectory(destination, true)
	if err != nil {
		s.finishImport(id, nil, err)
		return
	}
	dir.Close()
	source := input.Source
	builder := &packageBuilder{limits: s.options.Limits}
	switch source.Kind {
	case "directory":
		path := source.Path
		if source.Subdirectory != "" {
			path = filepath.Join(path, filepath.FromSlash(source.Subdirectory))
		}
		err = builder.directory(ctx, path, destination)
	case "zip":
		err = builder.archive(ctx, filepath.Join(stage, "source.zip"), destination)
	case "git":
		checkout := filepath.Join(stage, "checkout")
		var commit string
		commit, err = s.options.Git(ctx, source.URL, source.Ref, credential, checkout, s.options.Limits)
		credential = ""
		if err == nil {
			if len(commit) != 40 && len(commit) != 64 {
				err = problem(400, "invalid-git-commit", "Git 获取器未返回完整提交摘要")
			} else if _, e := hexDecode(commit); e != nil {
				err = problem(400, "invalid-git-commit", "Git 获取器返回无效提交摘要")
			}
		}
		if err == nil {
			source.Commit = commit
			path := checkout
			if source.Subdirectory != "" {
				path = filepath.Join(path, filepath.FromSlash(source.Subdirectory))
			}
			err = builder.directory(ctx, path, destination)
		}
	}
	if err != nil {
		s.finishImport(id, nil, err)
		return
	}
	manifest, digest, err := builder.finish(destination)
	if err != nil {
		s.finishImport(id, nil, err)
		return
	}
	if err = ctx.Err(); err != nil {
		s.finishImport(id, nil, err)
		return
	}
	skill := Skill{ID: input.SkillID, CreatedAt: s.stamp(), Enabled: input.Enabled, Source: source, Manifest: manifest, Digest: digest, Bytes: builder.bytes, Files: builder.files}
	if skill.ID == "" {
		skill.ID = randomID("skill-")
		skill.Revision = 1
	} else {
		skill.Revision = input.ExpectedRevision + 1
	}
	// 包先持久化；登记只引用完整包。失败留下无引用内容，不会覆盖旧修订。
	packagePath := filepath.Join(s.root, "packages", digest)
	if existing, e := openDirectory(packagePath, false); e == nil {
		existing.Close()
	} else {
		if err = os.Rename(destination, packagePath); err != nil {
			s.finishImport(id, nil, storageError())
			return
		}
		parent, e := openDirectory(filepath.Dir(packagePath), false)
		if e != nil {
			s.finishImport(id, nil, e)
			return
		}
		err = parent.Sync()
		parent.Close()
		if err != nil {
			s.finishImport(id, nil, storageError())
			return
		}
	}
	s.finishImport(id, &skill, nil)
}
func (s *Store) finishImport(id string, skill *Skill, cause error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable {
		return
	}
	next := clone(s.doc)
	for i := range next.Imports {
		task := &next.Imports[i]
		if task.ID != id {
			continue
		}
		if task.State != StateQueued && task.State != StateRunning {
			return
		}
		task.EndedAt = s.stamp()
		switch {
		case task.CancelRequestedAt != "":
			task.State = StateCancelled
			task.Error = nil
		case s.closed:
			task.State = StateInterrupted
			task.Error = &Failure{Code: "import-interrupted", Message: "技能导入因服务关闭中断"}
		case errors.Is(cause, context.DeadlineExceeded):
			task.State = StateFailed
			task.Error = &Failure{Code: "import-timeout", Message: "技能导入超过时间限制"}
		case cause != nil:
			task.State = StateFailed
			task.Error = &Failure{Code: "import-failed", Message: "技能导入失败，请检查来源与包内容"}
			var known *Error
			if errors.As(cause, &known) {
				task.Error = &Failure{Code: known.Code, Message: known.Message}
			}
		case skill != nil:
			if task.Input.SkillID != "" {
				latest, e := s.get(task.Input.SkillID, 0, true)
				if e != nil || latest.Revision != task.Input.ExpectedRevision {
					task.State = StateFailed
					task.Error = &Failure{Code: "skill-revision-conflict", Message: "导入期间技能修订已变化，请重新导入"}
					break
				}
			}
			task.State = StateSucceeded
			task.SkillID = skill.ID
			task.Revision = skill.Revision
			task.Source = skill.Source
			next.Skills = append(next.Skills, clone(*skill))
		default:
			task.State = StateInterrupted
			task.Error = &Failure{Code: "import-interrupted", Message: "技能导入未完成"}
		}
		_ = s.save(next)
		return
	}
}

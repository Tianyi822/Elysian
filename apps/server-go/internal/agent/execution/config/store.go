package config

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type Store struct {
	mu            sync.Mutex
	dir           *os.File
	lock          *os.File
	name          string
	mountRoot     string
	now           func() time.Time
	closed        bool
	beforePublish func() error
}

// Open 每次读写均在跨进程锁内读取磁盘事实，避免不同面板进程覆盖对方的修订。
// 配置父目录不允许符号链接；部署中已知的 ~/.Elysian 链接由可信路径层解析。
func Open(configPath string, options Options) (*Store, error) {
	if !filepath.IsAbs(configPath) || filepath.Clean(configPath) != configPath || filepath.Dir(configPath) == "/" {
		return nil, problem(400, "execution_invalid_path", "执行配置必须位于私有目录内并使用规范的绝对路径")
	}
	if err := validateMountRoot(options.MountRoot); err != nil {
		return nil, err
	}
	mount, err := openDirectory(options.MountRoot, false)
	if err != nil {
		return nil, problem(400, "execution_invalid_mount_root", "业务挂载根不存在或含符号链接")
	}
	mount.Close()
	dir, err := openDirectory(filepath.Dir(configPath), true)
	if err != nil {
		return nil, storageError(err)
	}
	name := filepath.Base(configPath)
	lock, err := openFile(dir, name+".lock", unix.O_RDWR|unix.O_CREAT)
	if err != nil {
		dir.Close()
		return nil, storageError(err)
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	s := &Store{dir: dir, lock: lock, name: name, mountRoot: options.MountRoot, now: options.Now}
	if err = s.withDocument(func(*document) error { return nil }); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return errors.Join(s.lock.Close(), s.dir.Close())
}

func (s *Store) withDocument(fn func(*document) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return problem(503, "execution_config_closed", "执行配置存储已关闭")
	}
	var current, opened unix.Stat_t
	if err := unix.Fstat(int(s.lock.Fd()), &opened); err != nil {
		return storageError(err)
	}
	if err := unix.Fstatat(int(s.dir.Fd()), s.name+".lock", &current, unix.AT_SYMLINK_NOFOLLOW); err != nil || opened.Ino != current.Ino || opened.Dev != current.Dev || opened.Nlink != 1 {
		return problem(409, "execution_config_lock_changed", "执行配置锁文件已变化，请重新打开存储")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := unix.Flock(int(s.lock.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if err != unix.EWOULDBLOCK && err != unix.EAGAIN {
			return storageError(err)
		}
		if time.Now().After(deadline) {
			return problem(503, "execution_config_busy", "执行配置正在由其他进程修改，请稍后重试")
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer unix.Flock(int(s.lock.Fd()), unix.LOCK_UN)
	d, err := s.read()
	if err != nil {
		return err
	}
	return fn(&d)
}

func (s *Store) ListProfiles() ([]Profile, error) {
	result := []Profile{}
	err := s.withDocument(func(d *document) error {
		latest := map[string]Profile{}
		for _, p := range d.Profiles {
			latest[p.ID] = p
		}
		for _, p := range latest {
			result = append(result, p)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		return nil
	})
	return result, err
}

func (s *Store) GetProfile(id string, revision int, allowDisabled bool) (Profile, error) {
	var result Profile
	err := s.withDocument(func(d *document) error {
		var err error
		result, err = resolveProfile(d.Profiles, id, revision, allowDisabled)
		return err
	})
	return result, err
}

func resolveProfile(records []Profile, id string, revision int, allowDisabled bool) (Profile, error) {
	var latest, selected Profile
	for _, p := range records {
		if p.ID == id {
			latest = p
			if p.Revision == revision {
				selected = p
			}
		}
	}
	if latest.ID == "" {
		return Profile{}, problem(404, "execution_profile_not_found", "执行环境配置不存在")
	}
	if revision == 0 {
		selected = latest
	}
	if selected.ID == "" {
		return Profile{}, problem(404, "execution_profile_revision_not_found", "执行环境配置修订不存在")
	}
	if !allowDisabled && (!latest.Enabled || !selected.Enabled) {
		return Profile{}, problem(409, "execution_profile_disabled", "执行环境已停用，不能用于新的操作")
	}
	return selected, nil
}

func (s *Store) PutProfile(input ProfileInput) (Profile, error) {
	profile, err := fromProfile(input)
	if err != nil {
		return Profile{}, err
	}
	err = s.withDocument(func(d *document) error {
		id, revision, err := profileIdentity(d.Profiles, input.ID, input.ExpectedRevision)
		if err != nil {
			return err
		}
		profile.ID, profile.Revision, profile.CreatedAt = id, revision, s.now().UTC().Format(time.RFC3339Nano)
		d.Profiles = append(d.Profiles, profile)
		return s.write(*d)
	})
	if err != nil {
		return Profile{}, err
	}
	return profile, nil
}

func profileIdentity(records []Profile, id string, expected int) (string, int, error) {
	if id == "" {
		if expected != 0 {
			return "", 0, problem(409, "execution_revision_conflict", "新建执行环境的预期修订必须为零")
		}
		id, err := randomID("profile-")
		if err != nil {
			return "", 0, storageError(err)
		}
		return id, 1, err
	}
	latest, err := resolveProfile(records, id, 0, true)
	if err != nil {
		return "", 0, err
	}
	if expected != latest.Revision {
		return "", 0, problem(409, "execution_revision_conflict", "执行环境已被修改，请重新读取后重试")
	}
	if latest.Revision == int(^uint(0)>>1) {
		return "", 0, problem(409, "execution_revision_limit", "执行环境修订数量达到上限")
	}
	return id, latest.Revision + 1, nil
}

func (s *Store) SetProfileEnabled(id string, expectedRevision int, enabled bool) (Profile, error) {
	var result Profile
	err := s.withDocument(func(d *document) error {
		_, revision, err := profileIdentity(d.Profiles, id, expectedRevision)
		if err != nil {
			return err
		}
		result, err = resolveProfile(d.Profiles, id, 0, true)
		if err != nil {
			return err
		}
		result.Revision, result.Enabled, result.CreatedAt = revision, enabled, s.now().UTC().Format(time.RFC3339Nano)
		d.Profiles = append(d.Profiles, result)
		return s.write(*d)
	})
	if err != nil {
		return Profile{}, err
	}
	return result, nil
}

func (s *Store) ListGrants() ([]Grant, error) {
	result := []Grant{}
	err := s.withDocument(func(d *document) error {
		latest := map[string]Grant{}
		for _, g := range d.Grants {
			latest[g.ID] = g
		}
		for _, g := range latest {
			result = append(result, g)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		return nil
	})
	return result, err
}

func (s *Store) GetGrant(id string, revision int, allowDisabled bool) (Grant, error) {
	var result Grant
	err := s.withDocument(func(d *document) error {
		var err error
		result, err = resolveGrant(d.Grants, id, revision, allowDisabled)
		if err == nil && !allowDisabled {
			err = ValidateGrant(result, s.mountRoot)
		}
		return err
	})
	return result, err
}

func resolveGrant(records []Grant, id string, revision int, allowDisabled bool) (Grant, error) {
	var latest, selected Grant
	for _, g := range records {
		if g.ID == id {
			latest = g
			if g.Revision == revision {
				selected = g
			}
		}
	}
	if latest.ID == "" {
		return Grant{}, problem(404, "execution_grant_not_found", "执行授权不存在")
	}
	if revision == 0 {
		selected = latest
	}
	if selected.ID == "" {
		return Grant{}, problem(404, "execution_grant_revision_not_found", "执行授权修订不存在")
	}
	if !allowDisabled && (!latest.Enabled || !selected.Enabled) {
		return Grant{}, problem(409, "execution_grant_disabled", "执行授权已停用，不能用于新的操作")
	}
	return selected, nil
}

func grantIdentity(records []Grant, id string, expected int) (string, int, error) {
	if id == "" {
		if expected != 0 {
			return "", 0, problem(409, "execution_revision_conflict", "新建执行授权的预期修订必须为零")
		}
		id, err := randomID("grant-")
		if err != nil {
			return "", 0, storageError(err)
		}
		return id, 1, err
	}
	latest, err := resolveGrant(records, id, 0, true)
	if err != nil {
		return "", 0, err
	}
	if expected != latest.Revision {
		return "", 0, problem(409, "execution_revision_conflict", "执行授权已被修改，请重新读取后重试")
	}
	if latest.Revision == int(^uint(0)>>1) {
		return "", 0, problem(409, "execution_revision_limit", "执行授权修订数量达到上限")
	}
	return id, latest.Revision + 1, nil
}

func (s *Store) PutGrant(input GrantInput) (Grant, error) {
	grant, err := fromGrant(input, s.mountRoot)
	if err != nil {
		return Grant{}, err
	}
	err = s.withDocument(func(d *document) error {
		id, revision, err := grantIdentity(d.Grants, input.ID, input.ExpectedRevision)
		if err != nil {
			return err
		}
		grant.ID, grant.Revision, grant.CreatedAt = id, revision, s.now().UTC().Format(time.RFC3339Nano)
		d.Grants = append(d.Grants, grant)
		return s.write(*d)
	})
	if err != nil {
		return Grant{}, err
	}
	return grant, nil
}

func (s *Store) SetGrantEnabled(id string, expectedRevision int, enabled bool) (Grant, error) {
	var result Grant
	err := s.withDocument(func(d *document) error {
		_, revision, err := grantIdentity(d.Grants, id, expectedRevision)
		if err != nil {
			return err
		}
		result, err = resolveGrant(d.Grants, id, 0, true)
		if err != nil {
			return err
		}
		result.Revision, result.Enabled, result.CreatedAt = revision, enabled, s.now().UTC().Format(time.RFC3339Nano)
		if enabled {
			if err = ValidateGrant(result, s.mountRoot); err != nil {
				return err
			}
		}
		d.Grants = append(d.Grants, result)
		return s.write(*d)
	})
	if err != nil {
		return Grant{}, err
	}
	return result, nil
}

package firewall

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"elysian/server/internal/atomicfile"
)

const (
	dockerWatchService = "elysian-docker-firewall-watch.service"
	systemdConfigDir   = "/etc/systemd/system/"
	dockerWatchFile    = systemdConfigDir + dockerWatchService
	dockerBootFile     = systemdConfigDir + "docker.service.d/40-elysian-firewall.conf"
	dockerLegacyFile   = systemdConfigDir + dockerFirewallService + ".d/50-elysian-compat.conf"
	dockerRecoveryFile = systemdConfigDir + dockerFirewallService + ".d/40-elysian-home-recovery.conf"
	dockerRecoveryUnit = "[Service]\nEnvironment=HOME=/var/lib/elysian\n"

	dockerBootUnit = `[Unit]
After=ufw.service
RequiresMountsFor=/opt/elysian/docker-firewall

[Service]
ExecStartPre=/usr/bin/env HOME=/var/lib/elysian /opt/elysian/docker-firewall/elysian docker-firewall-sync
`
	dockerWatchUnit = `[Unit]
Description=Elysian Docker firewall policy synchronization
After=ufw.service
RequiresMountsFor=/opt/elysian/docker-firewall

[Service]
Type=simple
Environment=HOME=/var/lib/elysian
ExecStartPre=/opt/elysian/docker-firewall/elysian docker-firewall-sync
ExecStart=/opt/elysian/docker-firewall/elysian docker-firewall-watch
Restart=on-failure
RestartSec=2s

[Install]
WantedBy=multi-user.target
`
	// Preserve the v1 ownership template used by old panel binaries. If
	// rollback enables that template again, Docker only depends on a finite
	// synchronization, never on the independent watcher process.
	dockerLegacyUnit = `[Service]
Type=oneshot
RemainAfterExit=yes
Environment=HOME=/var/lib/elysian
ExecStartPre=
ExecStart=
ExecStart=/opt/elysian/docker-firewall/elysian docker-firewall-sync
Restart=no
`
)

type dockerUnitFile struct{ path, content string }

var dockerV2Files = []dockerUnitFile{
	{dockerBootFile, dockerBootUnit},
	{dockerWatchFile, dockerWatchUnit},
	{dockerLegacyFile, dockerLegacyUnit},
}

func ownedSystemdFile(path, content string) (bool, error) {
	root := uint32(0)
	file, err := atomicfile.OpenTrusted(path, atomicfile.TrustOptions{OwnerUID: &root, RejectPerm: 0o022, MaxBytes: 4096, SingleLink: true})
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer file.Close()
	raw, err := io.ReadAll(file)
	if err != nil {
		return false, err
	}
	if string(raw) != content {
		return false, fmt.Errorf("Docker 防火墙 systemd 文件归属无法确认：%s", path)
	}
	return true, nil
}

func writeDockerUnit(file dockerUnitFile) error {
	dir := filepath.Dir(file.path)
	if err := os.Mkdir(dir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || !info.IsDir() || info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("Docker 防火墙 systemd 目录归属无法确认：%s", dir)
	}
	return atomicfile.WriteFile(file.path, []byte(file.content), atomicfile.WriteOptions{DirSync: true})
}

func removeOwnedDockerUnit(file dockerUnitFile) error {
	owned, err := ownedSystemdFile(file.path, file.content)
	if err != nil || !owned {
		return err
	}
	if err := os.Remove(file.path); err != nil {
		return err
	}
	return atomicfile.SyncDirectory(filepath.Dir(file.path))
}

func (d *dockerFirewall) systemctl(ctx context.Context, args ...string) (string, error) {
	return d.run(ctx, "", "systemctl", args...)
}

func missingDockerSystemdFiles() ([]dockerUnitFile, error) {
	var missing []dockerUnitFile
	for _, file := range dockerV2Files {
		owned, err := ownedSystemdFile(file.path, file.content)
		if err != nil {
			return nil, fmt.Errorf("Docker 防火墙 systemd 文件 %s：%w", file.path, err)
		}
		if !owned {
			missing = append(missing, file)
		}
	}
	if _, err := dockerFirewallUnitLinked(); err != nil {
		return nil, err
	}
	watchLink := filepath.Join(systemdConfigDir, "multi-user.target.wants", dockerWatchService)
	if _, err := dockerSystemdLink(watchLink, dockerWatchFile); err != nil {
		return nil, err
	}
	return missing, nil
}

func (d *dockerFirewall) installSystemd(ctx context.Context, upgradeHelper bool) (result error) {
	missing, err := missingDockerSystemdFiles()
	if err != nil {
		return err
	}
	var added []dockerUnitFile
	watchLink := filepath.Join(systemdConfigDir, "multi-user.target.wants", dockerWatchService)
	if upgradeHelper && len(missing) > 0 {
		// Update the standalone helper before publishing any new entry point.
		if err := copyDockerFirewallHelper(dockerFirewallRoot); err != nil {
			return err
		}
	}
	handoff := false
	defer func() {
		if result == nil || handoff || len(added) == 0 {
			return
		}
		recovery, cancel := context.WithTimeout(context.Background(), dockerFirewallTimeout)
		defer cancel()
		// Keep the old unit and its recovery drop-in until the new watchdog
		// and the Docker startup hook have both been verified.
		if slices.Contains(missing, dockerUnitFile{dockerWatchFile, dockerWatchUnit}) {
			_, disableErr := d.systemctl(recovery, "disable", "--now", dockerWatchService)
			// A failure before enable can leave no link or running service.
			if linked, linkErr := dockerSystemdLink(watchLink, dockerWatchFile); linked || linkErr != nil {
				result = errors.Join(result, disableErr, linkErr)
			}
		}
		for i := len(added) - 1; i >= 0; i-- {
			result = errors.Join(result, removeOwnedDockerUnit(added[i]))
		}
		_, reloadErr := d.systemctl(recovery, "daemon-reload")
		result = errors.Join(result, reloadErr)
	}()
	for _, file := range missing {
		if err := writeDockerUnit(file); err != nil {
			// An fsync error may follow a successful atomic replace.
			if installed, _ := ownedSystemdFile(file.path, file.content); installed {
				added = append(added, file)
			}
			return err
		}
		added = append(added, file)
	}
	if _, err := d.systemctl(ctx, "daemon-reload"); err != nil {
		return err
	}
	if err := d.verifyDockerBootHook(ctx); err != nil {
		return err
	}
	if _, err := d.systemctl(ctx, "enable", "--now", dockerWatchService); err != nil {
		return err
	}
	if _, err := d.systemctl(ctx, "is-active", "--quiet", dockerWatchService); err != nil {
		return err
	}
	if err := withDockerFirewallLock(ctx, func() error { return d.reconcile(ctx, false) }); err != nil {
		return err
	}
	handoff = true
	return d.retireLegacyDockerDependency(ctx)
}

func (d *dockerFirewall) verifyDockerBootHook(ctx context.Context) error {
	pre, err := d.systemctl(ctx, "show", "--property=ExecStartPre", "--value", "docker.service")
	if err != nil {
		return err
	}
	command := "argv[]=/usr/bin/env HOME=/var/lib/elysian " + dockerFirewallRoot + "/elysian docker-firewall-sync ; ignore_errors=no"
	if !strings.Contains(pre, command) {
		return errors.New("Docker 未加载 Elysian 防火墙启动钩子")
	}
	return nil
}

func dockerSystemdLink(path string, targets ...string) (bool, error) {
	target, err := os.Readlink(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(path), target)
	}
	if err != nil || !slices.Contains(targets, filepath.Clean(target)) {
		return false, fmt.Errorf("Docker 防火墙 systemd 链接归属无法确认：%s", path)
	}
	return true, nil
}

func (d *dockerFirewall) retireLegacyDockerDependency(ctx context.Context) error {
	primary := systemdConfigDir + dockerFirewallService
	unit := filepath.Join(dockerFirewallRoot, dockerFirewallService)
	for _, parent := range []string{"docker.service.requires/", "multi-user.target.wants/"} {
		link := systemdConfigDir + parent + dockerFirewallService
		linked, err := dockerSystemdLink(link, unit, primary)
		if err != nil {
			return err
		}
		if linked {
			if err := os.Remove(link); err != nil {
				return err
			}
			if err := atomicfile.SyncDirectory(filepath.Dir(link)); err != nil {
				return err
			}
		}
	}
	if _, err := d.systemctl(ctx, "daemon-reload"); err != nil {
		return err
	}
	requires, err := d.systemctl(ctx, "show", "--property=Requires", "--value", "docker.service")
	if err != nil {
		return err
	}
	if slices.Contains(strings.Fields(requires), dockerFirewallService) {
		return errors.New("Docker 仍依赖旧版防火墙服务")
	}
	linked, err := dockerSystemdLink(primary, unit)
	if err != nil {
		return err
	}
	if linked {
		if _, err := d.systemctl(ctx, "stop", dockerFirewallService); err != nil {
			return err
		}
	}
	// An administrator's own drop-in is left in place.
	if owned, _ := ownedSystemdFile(dockerRecoveryFile, dockerRecoveryUnit); owned {
		if err := removeOwnedDockerUnit(dockerUnitFile{dockerRecoveryFile, dockerRecoveryUnit}); err != nil {
			return err
		}
		_, err = d.systemctl(ctx, "daemon-reload")
	}
	return err
}

func (d *dockerFirewall) removeSystemd(ctx context.Context) error {
	var installed []dockerUnitFile
	for _, file := range dockerV2Files {
		owned, err := ownedSystemdFile(file.path, file.content)
		if err != nil {
			return err
		}
		if owned {
			installed = append(installed, file)
		}
	}
	watchLink := filepath.Join(systemdConfigDir, "multi-user.target.wants", dockerWatchService)
	linked, err := dockerSystemdLink(watchLink, dockerWatchFile)
	if err != nil {
		return err
	}
	hasWatcher := slices.Contains(installed, dockerUnitFile{dockerWatchFile, dockerWatchUnit})
	if linked && !hasWatcher {
		return errors.New("Docker 防火墙同步服务链接缺少受管单元")
	}
	if hasWatcher {
		if _, err := d.systemctl(ctx, "disable", "--now", dockerWatchService); err != nil {
			return err
		}
	}
	if owned, _ := ownedSystemdFile(dockerRecoveryFile, dockerRecoveryUnit); owned {
		installed = append(installed, dockerUnitFile{dockerRecoveryFile, dockerRecoveryUnit})
	}
	for _, file := range installed {
		if err := removeOwnedDockerUnit(file); err != nil {
			return err
		}
	}
	if len(installed) != 0 {
		_, err = d.systemctl(ctx, "daemon-reload")
	}
	return err
}

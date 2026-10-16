package config

import "testing"

func TestDirectoryGrantRejectsProtectedTreesAndTheirAncestors(t *testing.T) {
	for _, path := range []string{
		"/var/lib", "/var/lib/elysian", "/var/lib/elysian/config", "/var/lib/docker", "/var/lib/docker/containers",
		"/var/lib/containerd", "/var/lib/containerd/io.containerd", "/var/lib/apt", "/var/lib/apt/lists",
		"/var/lib/dpkg", "/var/lib/systemd", "/var/run", "/var/run/service", "/var/log", "/var/cache", "/var/spool",
	} {
		t.Run(path, func(t *testing.T) {
			err := validateDirectoryPath(Directory{Path: path, Access: "rw"}, "/var")
			requireErrorCode(t, err, "execution_unsafe_directory")
		})
	}
	for _, path := range []string{"/lib", "/lib/module", "/lib64", "/lib64/module"} {
		t.Run(path, func(t *testing.T) {
			err := validateDirectoryPath(Directory{Path: path, Access: "ro"}, "")
			requireErrorCode(t, err, "execution_unsafe_directory")
		})
	}
	for _, path := range []string{"/var/www", "/var/www/project", "/var/lib/business", "/var/library"} {
		t.Run(path, func(t *testing.T) {
			if err := validateDirectoryPath(Directory{Path: path, Access: "rw"}, "/var"); err != nil {
				t.Fatalf("ordinary business directory rejected: %v", err)
			}
		})
	}
}

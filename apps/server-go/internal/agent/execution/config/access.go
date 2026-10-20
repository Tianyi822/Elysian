package config

// CloneAccessScope prevents configuration and public responses from sharing
// mutable slices with a dispatch authorization.
func CloneAccessScope(scope *AccessScope) *AccessScope {
	if scope == nil {
		return nil
	}
	return &AccessScope{Directories: append([]Directory{}, scope.Directories...), Network: append([]NetworkEndpoint{}, scope.Network...), PrivateCIDRs: append([]string{}, scope.PrivateCIDRs...)}
}

// ValidateAccessDeclaration only checks shape and forbidden paths. Resolving
// the actual mount root and checking directory facts remains a dispatch gate.
func ValidateAccessDeclaration(scope AccessScope) error {
	if len(scope.Directories) > 16 {
		return problem(400, "execution_invalid_grant", "运行需求最多声明 16 个目录")
	}
	g := Grant{Name: "运行需求", Enabled: true, Directories: scope.Directories, Network: scope.Network, PrivateCIDRs: scope.PrivateCIDRs}
	return validateGrantShape(g, "")
}

func (s *Store) ValidateAccess(scope AccessScope) error {
	return ValidateGrant(Grant{Name: "运行需求", Enabled: true, Directories: scope.Directories, Network: scope.Network, PrivateCIDRs: scope.PrivateCIDRs}, s.mountRoot)
}

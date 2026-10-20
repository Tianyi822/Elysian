package harness

// approvedOperationMatches preserves pre-v5 approvals without claiming that
// administrators approved resource metadata that did not exist at that time.
// The caller independently derives and validates these three scheduling fields
// from the immutable Run snapshot. Every original approval field still has to
// match exactly; the persisted Approval.Operation is never rewritten.
func approvedOperationMatches(approved, current Operation) bool {
	if approved.Access != nil {
		current.Authorization = approved.Authorization
		current.Preparation = approved.Preparation
	}
	if approved.ClaimsDigest == "" {
		if len(approved.ResourceClaims) != 0 || len(approved.ResourceRules) != 0 {
			return false // A partially declared claim is not a legacy approval.
		}
		current.ResourceClaims = nil
		current.ResourceRules = nil
		current.ClaimsDigest = ""
	}
	return digestJSON(approved) == digestJSON(current)
}

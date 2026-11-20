package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (v *view) ResourceBlockedOperations(ctx context.Context, runID string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "ResourceBlockedOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), `SELECT document FROM operations WHERE run_id=? AND json_extract(document,'$.resourceWait.unknown')=1`, runID)
		return err
	})
	return values, normalizeError("ResourceBlockedOperations", err, v.tx != nil)
}

func (v *view) UnknownResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "UnknownResourceLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases WHERE state='unknown'")
		return err
	})
	return values, normalizeError("UnknownResourceLeases", err, v.tx != nil)
}

func (v *view) PendingProbeLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "PendingProbeLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases WHERE run_id='' AND operation_id=''")
		return err
	})
	return values, normalizeError("PendingProbeLeases", err, v.tx != nil)
}

func (v *view) ProbeLeaseRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("ProbeLeaseRecord", v.read(ctx, "ProbeLeaseRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) ResourceRules(ctx context.Context) ([]ResourceRule, error) {
	var values []ResourceRule
	err := v.read(ctx, "ResourceRules", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceRule](ctx, v.query(ctx), "SELECT r.document FROM resource_rules r JOIN (SELECT id,MAX(revision) AS revision FROM resource_rules GROUP BY id) latest ON r.id=latest.id AND r.revision=latest.revision ORDER BY r.id")
		return err
	})
	return values, normalizeError("ResourceRules", err, v.tx != nil)
}

func (v *view) ResourceRuleRevision(ctx context.Context, id string, count *int) error {
	return normalizeError("ResourceRuleRevision", v.read(ctx, "ResourceRuleRevision", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM resource_rules WHERE id=?", id).Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertResourceRule(ctx context.Context, id string, revision int, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO resource_rules(id,revision,document) VALUES(?,?,?)", id, revision, document)
	if err != nil {
		return 0, normalizeError("InsertResourceRule", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertResourceRule", err, true)
}

func (v *view) WaitingResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "WaitingResourceLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases WHERE state='waiting' ORDER BY sequence")
		return err
	})
	return values, normalizeError("WaitingResourceLeases", err, v.tx != nil)
}

func (v *view) ResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "ResourceLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases ORDER BY CASE WHEN state IN ('waiting','held','unknown') THEN 0 ELSE 1 END,sequence DESC LIMIT 200")
		return err
	})
	return values, normalizeError("ResourceLeases", err, v.tx != nil)
}

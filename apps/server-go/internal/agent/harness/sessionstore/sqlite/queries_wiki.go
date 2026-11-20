package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (v *transaction) FinishEmbeddingRequest(ctx context.Context, now string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "DELETE FROM wiki_embedding_requests WHERE state<>'running' AND julianday(json_extract(document,'$.endedAt'))<julianday(?)", now)
	if err != nil {
		return 0, normalizeError("FinishEmbeddingRequest", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("FinishEmbeddingRequest", err, true)
}

func (v *view) PendingEmbeddingRequests(ctx context.Context) ([]EmbeddingRequest, error) {
	var values []EmbeddingRequest
	err := v.read(ctx, "PendingEmbeddingRequests", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[EmbeddingRequest](ctx, v.query(ctx), "SELECT document FROM wiki_embedding_requests WHERE state='running'")
		return err
	})
	return values, normalizeError("PendingEmbeddingRequests", err, v.tx != nil)
}

func (v *transaction) InsertOperationArtifact(ctx context.Context, key string, taskID string, runID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT OR IGNORE INTO wiki_artifacts(kind,id,task_id,run_id) VALUES('workspace',?,?,?)", key, taskID, runID)
	if err != nil {
		return 0, normalizeError("InsertOperationArtifact", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertOperationArtifact", err, true)
}

func (v *transaction) InsertOperationDependency(ctx context.Context, key string, pageID string, revision int, digest string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT OR IGNORE INTO wiki_dependencies(kind,id,page_id,revision,digest) VALUES('workspace',?,?,?,?)", key, pageID, revision, digest)
	if err != nil {
		return 0, normalizeError("InsertOperationDependency", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertOperationDependency", err, true)
}

func (v *transaction) InvalidateOperationArtifact(ctx context.Context, key string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE wiki_artifacts SET invalidated=1 WHERE kind='workspace' AND id=?", key)
	if err != nil {
		return 0, normalizeError("InvalidateOperationArtifact", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InvalidateOperationArtifact", err, true)
}

func (v *view) WikiDependentWorkflows(ctx context.Context, pageID string) ([]WorkflowInstance, error) {
	var values []WorkflowInstance
	err := v.read(ctx, "WikiDependentWorkflows", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowInstance](ctx, v.query(ctx), `SELECT DISTINCT w.document FROM workflow_instances w JOIN tasks t ON t.session_id=w.session_id JOIN wiki_artifacts a ON a.task_id=t.id JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1 AND json_extract(w.document,'$.languageVersion')='workflow/v2' AND w.state NOT IN ('succeeded','failed','cancelled')`, pageID)
		return err
	})
	return values, normalizeError("WikiDependentWorkflows", err, v.tx != nil)
}

func (v *view) WikiDependentNodes(ctx context.Context, workflowID string, pageID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "WikiDependentNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), `SELECT n.document FROM workflow_nodes n WHERE n.workflow_id=? AND n.state IN ('ready','queued','running','waiting-approval','waiting-resource','waiting-task') AND json_extract(n.document,'$.taskId') IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1) ORDER BY n.rowid`, workflowID, pageID)
		return err
	})
	return values, normalizeError("WikiDependentNodes", err, v.tx != nil)
}

func (v *view) WikiRecallRecord(ctx context.Context, runID string, document *string) error {
	return normalizeError("WikiRecallRecord", v.read(ctx, "WikiRecallRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_recalls WHERE run_id=?", runID).Scan(document)
	}), v.tx != nil)
}

func (v *view) RunWikiSelection(ctx context.Context, runID string, document *string) error {
	return normalizeError("RunWikiSelection", v.read(ctx, "RunWikiSelection", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_run_spaces WHERE run_id=?", runID).Scan(document)
	}), v.tx != nil)
}

func (v *view) RunWikiPages(ctx context.Context, runID string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "RunWikiPages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), `SELECT r.document FROM wiki_visible_pages v JOIN wiki_page_revisions r ON r.page_id=v.page_id AND r.revision=v.revision WHERE v.owner_kind='run' AND v.owner_id=?`, runID)
		return err
	})
	return values, normalizeError("RunWikiPages", err, v.tx != nil)
}

func (v *transaction) SaveWikiRecall(ctx context.Context, runID string, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_recalls(run_id,document) VALUES(?,?)", runID, document)
	if err != nil {
		return 0, normalizeError("SaveWikiRecall", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("SaveWikiRecall", err, true)
}

func (v *transaction) InvalidateWikiArtifacts(ctx context.Context, pageID string, value string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `UPDATE wiki_artifacts SET invalidated=1 WHERE (kind,id) IN (SELECT kind,id FROM wiki_dependencies WHERE page_id=?) OR (kind='page' AND id LIKE ?)`, pageID, value)
	if err != nil {
		return 0, normalizeError("InvalidateWikiArtifacts", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InvalidateWikiArtifacts", err, true)
}

func (v *view) ActiveWikiWorkflows(ctx context.Context, pageID string) ([]WorkflowInstance, error) {
	var values []WorkflowInstance
	err := v.read(ctx, "ActiveWikiWorkflows", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowInstance](ctx, v.query(ctx), `SELECT w.document FROM workflow_instances w WHERE w.state NOT IN ('succeeded','failed','cancelled') AND COALESCE(json_extract(w.document,'$.languageVersion'),'')<>'workflow/v2' AND json_extract(w.document,'$.taskId') IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1)`, pageID)
		return err
	})
	return values, normalizeError("ActiveWikiWorkflows", err, v.tx != nil)
}

func (v *view) WikiAffectedTasks(ctx context.Context, pageID string) ([]sessionstore.WikiAffectedTask, error) {
	values := []sessionstore.WikiAffectedTask{}
	err := v.read(ctx, "WikiAffectedTasks", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT DISTINCT a.task_id FROM wiki_artifacts a JOIN tasks t ON t.id=a.task_id JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE a.invalidated=1 AND d.page_id=?`, pageID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiAffectedTask
			if err := rows.Scan(&item.TaskID); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiAffectedTasks", err, v.tx != nil)
}

func (v *transaction) AdvanceWikiGeneration(ctx context.Context, taskID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `INSERT INTO wiki_task_contexts(task_id,generation) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET generation=generation+1`, taskID)
	if err != nil {
		return 0, normalizeError("AdvanceWikiGeneration", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("AdvanceWikiGeneration", err, true)
}

func (v *view) WikiAffectedRuns(ctx context.Context, pageID string) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "WikiAffectedRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), `SELECT r.document FROM runs r WHERE r.task_id IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE a.invalidated=1 AND d.page_id=?) AND r.state IN ('queued','running','waiting-input','waiting-approval','waiting-resource','waiting-task','waiting-recovery','waiting-model','waiting-storage','recovery-required')`, pageID)
		return err
	})
	return values, normalizeError("WikiAffectedRuns", err, v.tx != nil)
}

func (v *transaction) RetireInvalidWikiCandidates(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `UPDATE wiki_candidates SET state='invalidated',document=json_set(document,'$.status','invalidated') WHERE id IN (SELECT id FROM wiki_artifacts WHERE kind='candidate' AND invalidated=1) AND state='pending'`)
	if err != nil {
		return 0, normalizeError("RetireInvalidWikiCandidates", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RetireInvalidWikiCandidates", err, true)
}

func (v *view) InvalidWikiRuns(ctx context.Context) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "InvalidWikiRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE state='running'")
		return err
	})
	return values, normalizeError("InvalidWikiRuns", err, v.tx != nil)
}

func (v *view) WikiTextMatches(ctx context.Context, value string, spaceID string) ([]sessionstore.WikiTextMatch, error) {
	values := []sessionstore.WikiTextMatch{}
	err := v.read(ctx, "WikiTextMatches", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ? AND (?='' OR space_id=?)`, value, spaceID, spaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiTextMatch
			if err := rows.Scan(&item.PageID); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiTextMatches", err, v.tx != nil)
}

func (v *view) WikiEmbeddingMatches(ctx context.Context, id string, revision int) ([]sessionstore.WikiEmbeddingMatch, error) {
	values := []sessionstore.WikiEmbeddingMatch{}
	err := v.read(ctx, "WikiEmbeddingMatches", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT page_id,page_revision,digest,vector FROM wiki_embedding_indexes WHERE profile_id=? AND profile_revision=?", id, revision)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiEmbeddingMatch
			if err := rows.Scan(&item.PageID, &item.Revision, &item.Digest, &item.Vector); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiEmbeddingMatches", err, v.tx != nil)
}

func (v *view) RecoverableWikiJobs(ctx context.Context) ([]sessionstore.StoredWikiJob, error) {
	var values []sessionstore.StoredWikiJob
	err := v.read(ctx, "RecoverableWikiJobs", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[sessionstore.StoredWikiJob](ctx, v.query(ctx), "SELECT document FROM wiki_jobs WHERE state IN ('queued','running')")
		return err
	})
	return values, normalizeError("RecoverableWikiJobs", err, v.tx != nil)
}

func (v *view) WikiDirectory(ctx context.Context, space string, value int, offset int64) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiDirectory", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT document FROM wiki_pages WHERE space_id=? AND status='active' ORDER BY slug,id LIMIT ? OFFSET ?", space, value, offset)
		return err
	})
	return values, normalizeError("WikiDirectory", err, v.tx != nil)
}

func (v *view) WikiPageRevisions(ctx context.Context, space string, id string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiPageRevisions", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT r.document FROM wiki_page_revisions r JOIN wiki_pages p ON p.id=r.page_id WHERE p.space_id=? AND r.page_id=? ORDER BY r.revision DESC", space, id)
		return err
	})
	return values, normalizeError("WikiPageRevisions", err, v.tx != nil)
}

func (v *view) WikiVisiblePages(ctx context.Context, runID string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiVisiblePages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), `SELECT p.document FROM wiki_visible_pages v JOIN wiki_page_revisions p ON p.page_id=v.page_id AND p.revision=v.revision WHERE v.owner_kind='run' AND v.owner_id=? ORDER BY v.page_id`, runID)
		return err
	})
	return values, normalizeError("WikiVisiblePages", err, v.tx != nil)
}

func (v *view) WikiSourcesCleared(ctx context.Context, runID string, count *int) error {
	return normalizeError("WikiSourcesCleared", v.read(ctx, "WikiSourcesCleared", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_cleared_sources WHERE run_id=?", runID).Scan(count)
	}), v.tx != nil)
}

func (v *view) WikiSessionSelection(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiSessionSelection", v.read(ctx, "WikiSessionSelection", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_session_spaces WHERE session_id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *transaction) InsertWikiSpaceRevision(ctx context.Context, id string, revision int, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_space_revisions(id,revision,document) VALUES(?,?,?)", id, revision, raw)
	if err != nil {
		return 0, normalizeError("InsertWikiSpaceRevision", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWikiSpaceRevision", err, true)
}

func (v *transaction) UpdateWikiSpace(ctx context.Context, name string, document string, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE wiki_spaces SET name=?,document=? WHERE id=?", name, document, id)
	if err != nil {
		return 0, normalizeError("UpdateWikiSpace", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("UpdateWikiSpace", err, true)
}

func (v *view) WikiPageRevision(ctx context.Context, space string, id string, revision int, document *string) error {
	return normalizeError("WikiPageRevision", v.read(ctx, "WikiPageRevision", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT r.document FROM wiki_page_revisions r JOIN wiki_pages p ON p.id=r.page_id WHERE p.space_id=? AND r.page_id=? AND r.revision=?`, space, id, revision).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiSpaceRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiSpaceRecord", v.read(ctx, "WikiSpaceRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_spaces WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiSpaces(ctx context.Context) ([]sessionstore.WikiSpaceDocument, error) {
	values := []sessionstore.WikiSpaceDocument{}
	err := v.read(ctx, "WikiSpaces", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT document FROM wiki_spaces ORDER BY kind DESC,name,id")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiSpaceDocument
			if err := rows.Scan(&item.Document); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiSpaces", err, v.tx != nil)
}

func (v *view) WikiSpaceCount(ctx context.Context, count *int) error {
	return normalizeError("WikiSpaceCount", v.read(ctx, "WikiSpaceCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_spaces WHERE kind='global'").Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertWikiSpace(ctx context.Context, id string, name string, kind string, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_spaces(id,name,kind,document) VALUES(?,?,?,?)", id, name, kind, raw)
	if err != nil {
		return 0, normalizeError("InsertWikiSpace", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWikiSpace", err, true)
}

func (v *transaction) SaveWikiSessionSelection(ctx context.Context, sessionID string, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_session_spaces(session_id,document) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET document=excluded.document", sessionID, raw)
	if err != nil {
		return 0, normalizeError("SaveWikiSessionSelection", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("SaveWikiSessionSelection", err, true)
}

func (v *view) DefaultWikiSpace(ctx context.Context, document *string) error {
	return normalizeError("DefaultWikiSpace", v.read(ctx, "DefaultWikiSpace", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT id FROM wiki_spaces WHERE kind='global'").Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiPageRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiPageRecord", v.read(ctx, "WikiPageRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_pages WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiRevisionDigest(ctx context.Context, pageID string, revision int, document *string) error {
	return normalizeError("WikiRevisionDigest", v.read(ctx, "WikiRevisionDigest", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT digest FROM wiki_page_revisions WHERE page_id=? AND revision=?", pageID, revision).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiExportPages(ctx context.Context, id string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiExportPages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT document FROM wiki_page_revisions WHERE page_id=? ORDER BY revision", id)
		return err
	})
	return values, normalizeError("WikiExportPages", err, v.tx != nil)
}

func (v *transaction) InsertWikiCandidate(ctx context.Context, id string, spaceID string, status string, originKind string, originID string, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_candidates(id,space_id,state,origin_kind,origin_id,document) VALUES(?,?,?,?,?,?)", id, spaceID, status, originKind, originID, raw)
	if err != nil {
		return 0, normalizeError("InsertWikiCandidate", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWikiCandidate", err, true)
}

func (v *view) WikiCandidateRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiCandidateRecord", v.read(ctx, "WikiCandidateRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_candidates WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiPageBySlug(ctx context.Context, pageID string, spaceID string, document *string) error {
	return normalizeError("WikiPageBySlug", v.read(ctx, "WikiPageBySlug", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_pages WHERE id=? AND space_id=?", pageID, spaceID).Scan(document)
	}), v.tx != nil)
}

func (v *transaction) UpdateWikiCandidate(ctx context.Context, status string, doc string, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE wiki_candidates SET state=?,document=? WHERE id=?", status, doc, id)
	if err != nil {
		return 0, normalizeError("UpdateWikiCandidate", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("UpdateWikiCandidate", err, true)
}

func (v *view) ListWikiPages(ctx context.Context, spaceID string, includeWithdrawn bool) (values []WikiPage, err error) {
	err = v.read(ctx, "wiki-pages", func(ctx context.Context) error {
		var e error
		values, e = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT document FROM wiki_pages WHERE (?='' OR space_id=?) AND (? OR status<>'withdrawn') ORDER BY rowid DESC", spaceID, spaceID, includeWithdrawn)
		return e
	})
	return values, normalizeError("wiki-pages", err, v.tx != nil)
}

func (v *view) ListWikiCandidates(ctx context.Context, spaceID, status string) (values []WikiCandidate, err error) {
	err = v.read(ctx, "wiki-candidates", func(ctx context.Context) error {
		var e error
		values, e = readDocuments[WikiCandidate](ctx, v.query(ctx), "SELECT document FROM wiki_candidates WHERE (?='' OR space_id=?) AND (?='' OR state=?) ORDER BY rowid DESC", spaceID, spaceID, status, status)
		return e
	})
	return values, normalizeError("wiki-candidates", err, v.tx != nil)
}

func (v *view) EmbeddingRequests(ctx context.Context, offset int64, limit int) (page Page[EmbeddingRequest], err error) {
	err = v.read(ctx, "embedding-requests", func(ctx context.Context) error {
		rows, e := v.query(ctx).QueryContext(ctx, "SELECT rowid,document FROM wiki_embedding_requests WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", offset, offset, limit+1)
		if e != nil {
			return e
		}
		page, e = documentPage[EmbeddingRequest](rows, limit, 0, "")
		return e
	})
	return page, normalizeError("embedding-requests", err, v.tx != nil)
}

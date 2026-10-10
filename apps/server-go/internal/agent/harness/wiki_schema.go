package harness

const wikiSchema = `
CREATE TABLE IF NOT EXISTS wiki_spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_space_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_cleared_sources(run_id TEXT PRIMARY KEY,cleared_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_global_space ON wiki_spaces(kind) WHERE kind='global';
CREATE TABLE IF NOT EXISTS wiki_pages(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES wiki_spaces(id),slug TEXT NOT NULL,
 current_revision INTEGER NOT NULL,status TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(space_id,slug));
CREATE TABLE IF NOT EXISTS wiki_page_revisions(page_id TEXT NOT NULL REFERENCES wiki_pages(id),revision INTEGER NOT NULL,
 digest TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(page_id,revision));
CREATE TABLE IF NOT EXISTS wiki_candidates(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES wiki_spaces(id),state TEXT NOT NULL,
 origin_kind TEXT NOT NULL,origin_id TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_session_spaces(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_run_spaces(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_visible_pages(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,page_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,page_id));
CREATE TABLE IF NOT EXISTS wiki_recalls(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_task_contexts(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wiki_artifacts(kind TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',
 generation INTEGER NOT NULL DEFAULT 0,invalidated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
CREATE INDEX IF NOT EXISTS wiki_artifacts_task ON wiki_artifacts(task_id,invalidated);
CREATE TABLE IF NOT EXISTS wiki_dependencies(kind TEXT NOT NULL,id TEXT NOT NULL,page_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,
 PRIMARY KEY(kind,id,page_id,revision),FOREIGN KEY(kind,id) REFERENCES wiki_artifacts(kind,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS wiki_dependencies_page ON wiki_dependencies(page_id,revision);
CREATE TABLE IF NOT EXISTS wiki_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,origin_kind TEXT NOT NULL,origin_id TEXT NOT NULL,
 state TEXT NOT NULL,document TEXT NOT NULL,input TEXT NOT NULL,UNIQUE(kind,origin_kind,origin_id));
CREATE INDEX IF NOT EXISTS wiki_jobs_state ON wiki_jobs(state);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(page_id UNINDEXED,space_id UNINDEXED,title,body,tokenize='unicode61');
` + embeddingSchema

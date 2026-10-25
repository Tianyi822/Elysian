package tui

import (
	"context"
	"elysian/server/internal/cli/client"
)

type contextAPI struct {
	API
	ctx context.Context
}

func (a contextAPI) requestContext() context.Context { return a.ctx }
func withLifetime(api API, ctx context.Context) API {
	if api == nil {
		return nil
	}
	return contextAPI{API: api, ctx: ctx}
}
func (a contextAPI) bound(ctx context.Context) (context.Context, func()) {
	c, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(a.ctx, cancel)
	if a.ctx.Err() != nil {
		cancel()
	}
	return c, func() { stop(); cancel() }
}
func (a contextAPI) Login(ctx context.Context, username, password string) error {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.Login(ctx, username, password)
}
func (a contextAPI) ProbeSession(ctx context.Context) (bool, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ProbeSession(ctx)
}
func (a contextAPI) Logout(ctx context.Context) error {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.Logout(ctx)
}
func (a contextAPI) ListRuns(ctx context.Context, sessionID, requestID, cursor string) (client.Page[client.Run], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListRuns(ctx, sessionID, requestID, cursor)
}
func (a contextAPI) ModelRequests(ctx context.Context, runID, cursor string) (client.Page[client.ModelRequest], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ModelRequests(ctx, runID, cursor)
}
func (a contextAPI) ListSessionTasksPage(ctx context.Context, sessionID, cursor string) (client.Page[client.Task], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListSessionTasksPage(ctx, sessionID, cursor)
}
func (a contextAPI) UploadImage(ctx context.Context, name string, content []byte) (client.MessageAttachment, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.UploadImage(ctx, name, content)
}
func (a contextAPI) AttachmentContent(ctx context.Context, id string) ([]byte, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.AttachmentContent(ctx, id)
}
func (a contextAPI) ListSessionsByActivity(ctx context.Context, cursor string) (client.Page[client.Session], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListSessionsByActivity(ctx, cursor)
}
func (a contextAPI) GetSession(ctx context.Context, id string) (client.Session, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.GetSession(ctx, id)
}
func (a contextAPI) CreateSession(ctx context.Context, in client.CreateSessionInput) (client.Session, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.CreateSession(ctx, in)
}
func (a contextAPI) RenameSession(ctx context.Context, id, title string) (client.Session, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.RenameSession(ctx, id, title)
}
func (a contextAPI) DeleteSession(ctx context.Context, id string) error {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.DeleteSession(ctx, id)
}
func (a contextAPI) SwitchSessionModel(ctx context.Context, id string, in client.SwitchModelInput) (client.Session, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.SwitchSessionModel(ctx, id, in)
}
func (a contextAPI) ListModelProfiles(ctx context.Context) ([]client.ModelProfile, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListModelProfiles(ctx)
}
func (a contextAPI) ListSessionTasks(ctx context.Context, id string, limit int) (client.Page[client.Task], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListSessionTasks(ctx, id, limit)
}
func (a contextAPI) GetRun(ctx context.Context, id string) (client.Run, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.GetRun(ctx, id)
}
func (a contextAPI) ListMessages(ctx context.Context, id, after string) (client.Page[client.Message], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListMessages(ctx, id, after)
}
func (a contextAPI) CreateTask(ctx context.Context, id string, in client.AgentInput) (client.Run, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.CreateTask(ctx, id, in)
}
func (a contextAPI) ContinueTask(ctx context.Context, id string, in client.AgentInput) (client.Run, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ContinueTask(ctx, id, in)
}
func (a contextAPI) CancelRun(ctx context.Context, id string) (client.Run, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.CancelRun(ctx, id)
}
func (a contextAPI) TimelineSnapshot(ctx context.Context, id string) (client.ChatTimeline, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.TimelineSnapshot(ctx, id)
}
func (a contextAPI) ListApprovalsByRun(ctx context.Context, id string) ([]client.Approval, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListApprovalsByRun(ctx, id)
}
func (a contextAPI) DecideApproval(ctx context.Context, id, decision string) (client.Approval, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.DecideApproval(ctx, id, decision)
}
func (a contextAPI) DecideAccess(ctx context.Context, id string, in client.AccessDecisionInput) (client.Approval, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.DecideAccess(ctx, id, in)
}
func (a contextAPI) ListSessionAuthorizations(ctx context.Context, id string) ([]client.SessionAuthorization, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListSessionAuthorizations(ctx, id)
}
func (a contextAPI) RevokeSessionAuthorization(ctx context.Context, sessionID, id string, in client.RevokeAuthorizationInput) error {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.RevokeSessionAuthorization(ctx, sessionID, id, in)
}
func (a contextAPI) AnswerUserInput(ctx context.Context, runID, id string, in client.AnswerUserInputInput) (client.UserInputReceipt, error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.AnswerUserInput(ctx, runID, id, in)
}
func (a contextAPI) ListCalls(ctx context.Context, id, cursor string) (client.Page[client.Call], error) {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.ListCalls(ctx, id, cursor)
}
func (a contextAPI) StreamChatOutput(ctx context.Context, id string, fn func(client.ChatOutput) error) error {
	ctx, done := a.bound(ctx)
	defer done()
	return a.API.StreamChatOutput(ctx, id, fn)
}

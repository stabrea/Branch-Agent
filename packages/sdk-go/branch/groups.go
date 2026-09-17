package branch

import (
	"context"
	"net/http"
)

// Runs starts, reads, steers and stops tasks.
type Runs struct{ c *Client }

// Start starts a task. input carries the same fields the app takes (sessionId, temporary, plan, ...).
func (r *Runs) Start(ctx context.Context, prompt string, input Object) (Object, error) {
	body := Object{}
	for name, value := range input {
		body[name] = value
	}
	body["prompt"] = prompt
	return r.c.Post(ctx, "/api/run", body)
}

// Get is one task with its events, its messages and what it has used so far.
func (r *Runs) Get(ctx context.Context, runID string) (Object, error) {
	return r.c.Get(ctx, "/api/runs/"+segment(runID))
}

// Steer says something to a task while it is working.
func (r *Runs) Steer(ctx context.Context, runID, text string) (Object, error) {
	return r.c.Post(ctx, "/api/runs/"+segment(runID)+"/steer", Object{"text": text})
}

// Cancel stops a task.
func (r *Runs) Cancel(ctx context.Context, runID string) (Object, error) {
	return r.c.Post(ctx, "/api/runs/"+segment(runID)+"/cancel", nil)
}

// Resume picks a task up again after it was interrupted.
func (r *Runs) Resume(ctx context.Context, runID string) (Object, error) {
	return r.c.Post(ctx, "/api/runs/"+segment(runID)+"/resume", nil)
}

// Approve answers the question a paused task stopped on: "allow" or "deny"; remember is
// "never", "session" or "always".
func (r *Runs) Approve(ctx context.Context, sessionID, decision, remember string) (Object, error) {
	return r.c.Policy.Approve(ctx, sessionID, decision, remember)
}

// Receipts is every tool result of a task with whether its receipt is genuine.
func (r *Runs) Receipts(ctx context.Context, runID string) (Object, error) {
	return r.c.Get(ctx, "/api/runs/"+segment(runID)+"/receipts")
}

// Activity is the tasks in progress, with what each one is doing right now.
func (r *Runs) Activity(ctx context.Context) (Object, error) { return r.c.Get(ctx, "/api/activity") }

// Sessions reads and searches conversations.
type Sessions struct{ c *Client }

// Get is one conversation with its messages.
func (s *Sessions) Get(ctx context.Context, sessionID string) (Object, error) {
	return s.c.Get(ctx, "/api/sessions/"+segment(sessionID))
}

// Search looks through conversations.
func (s *Sessions) Search(ctx context.Context, query string) (Object, error) {
	return s.c.Post(ctx, "/api/sessions/search", Object{"query": query})
}

// Summary is a short account of one conversation.
func (s *Sessions) Summary(ctx context.Context, sessionID string) (Object, error) {
	return s.c.Get(ctx, "/api/sessions/"+segment(sessionID)+"/summary")
}

// Export is one conversation in full, ready to keep.
func (s *Sessions) Export(ctx context.Context, sessionID string) (Object, error) {
	return s.c.Get(ctx, "/api/sessions/"+segment(sessionID)+"/export")
}

// FollowUp sends the next message in a conversation.
func (s *Sessions) FollowUp(ctx context.Context, sessionID, prompt string) (Object, error) {
	return s.c.Post(ctx, "/api/sessions/"+segment(sessionID)+"/followups", Object{"prompt": prompt})
}

// Memory searches and exports what the assistant was asked to remember.
type Memory struct{ c *Client }

// Search looks through the saved facts; a limit of 0 leaves the app's own limit.
func (m *Memory) Search(ctx context.Context, query string, limit int) (Object, error) {
	body := Object{"query": query}
	if limit > 0 {
		body["limit"] = limit
	}
	return m.c.Post(ctx, "/api/memory/search", body)
}

// Export is everything the assistant has been asked to remember.
func (m *Memory) Export(ctx context.Context) (Object, error) {
	return m.c.Get(ctx, "/api/memory/export")
}

// Documents adds, searches and removes documents.
type Documents struct{ c *Client }

// List is every document.
func (d *Documents) List(ctx context.Context) (Object, error) { return d.c.Get(ctx, "/api/documents") }

// Add keeps a document under a name.
func (d *Documents) Add(ctx context.Context, name, text string) (Object, error) {
	return d.c.Post(ctx, "/api/documents", Object{"name": name, "text": text})
}

// Search looks through the documents; a limit of 0 leaves the app's own limit.
func (d *Documents) Search(ctx context.Context, query string, limit int) (Object, error) {
	body := Object{"query": query}
	if limit > 0 {
		body["limit"] = limit
	}
	return d.c.Post(ctx, "/api/documents/search", body)
}

// Remove takes one document away.
func (d *Documents) Remove(ctx context.Context, documentID string) (Object, error) {
	return d.c.Request(ctx, http.MethodDelete, "/api/documents/"+segment(documentID), nil)
}

// Schedules reads and sets off schedules.
type Schedules struct{ c *Client }

// Get is one schedule.
func (s *Schedules) Get(ctx context.Context, scheduleID string) (Object, error) {
	return s.c.Get(ctx, "/api/schedules/"+segment(scheduleID))
}

// Trigger runs a schedule now.
func (s *Schedules) Trigger(ctx context.Context, scheduleID string) (Object, error) {
	return s.c.Post(ctx, "/api/schedules/"+segment(scheduleID)+"/trigger", nil)
}

// Policy reads and changes the approval settings.
type Policy struct{ c *Client }

// Get is the saved approval settings, the presets on offer, and anything waiting on an answer.
func (p *Policy) Get(ctx context.Context) (Object, error) { return p.c.Get(ctx, "/api/policy") }

// Save changes the approval settings.
func (p *Policy) Save(ctx context.Context, settings Object) (Object, error) {
	return p.c.Post(ctx, "/api/policy", settings)
}

// Approve answers the question a paused task stopped on.
func (p *Policy) Approve(ctx context.Context, sessionID, decision, remember string) (Object, error) {
	if remember == "" {
		remember = "session"
	}
	return p.c.Post(ctx, "/api/policy/approve", Object{"sessionId": sessionID, "decision": decision, "remember": remember})
}

// Categories is the approvals decided a kind of thing at a time.
func (p *Policy) Categories(ctx context.Context) (Object, error) {
	return p.c.Get(ctx, "/api/approvals/categories")
}

// Flows lists, saves and starts flows, and writes them out as YAML and reads them back.
type Flows struct{ c *Client }

// List is every saved flow as boxes and arrows.
func (f *Flows) List(ctx context.Context) (Object, error) { return f.c.Get(ctx, "/api/flows") }

// Get is one saved flow.
func (f *Flows) Get(ctx context.Context, flowID string) (Object, error) {
	return f.c.Get(ctx, "/api/flows/"+segment(flowID))
}

// Save keeps a flow.
func (f *Flows) Save(ctx context.Context, flow Object) (Object, error) {
	return f.c.Post(ctx, "/api/flows", flow)
}

// Run starts a saved flow with its input.
func (f *Flows) Run(ctx context.Context, flowID string, input Object) (Object, error) {
	return f.c.Post(ctx, "/api/flows/"+segment(flowID)+"/run", input)
}

// ExportYAML is one saved flow written as YAML (the "yaml" field of the answer). Tools for
// people building on Branch must be switched on in Settings.
func (f *Flows) ExportYAML(ctx context.Context, flowID string) (string, error) {
	answer, err := f.c.Get(ctx, "/api/flows/"+segment(flowID)+"/yaml")
	if err != nil {
		return "", err
	}
	text, _ := answer["yaml"].(string)
	return text, nil
}

// ImportYAML saves a flow written as YAML, always as a new flow.
func (f *Flows) ImportYAML(ctx context.Context, text string) (Object, error) {
	return f.c.Post(ctx, "/api/flows/yaml", Object{"yaml": text})
}

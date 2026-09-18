// Package branch is the Branch Agent client for Go.
//
// It uses only the standard library to talk to the copy of Branch Agent already running on this
// computer, with the same address and the same local session key the app itself uses. It matches
// the JavaScript client in packages/sdk and the Python client in packages/sdk-python group for
// group. Every answer is the app's own JSON, handed back as an Object; the full list of routes is
// served by the app at /api/openapi.json and written out in docs/api.md.
package branch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// DefaultPort is the port Branch Agent listens on unless it was told otherwise.
const DefaultPort = 3210

// Object is one JSON answer from the app.
type Object = map[string]any

// Error is a request Branch Agent refused, carrying the app's own plain-language message.
// A Status of 0 means the app could not be reached at all.
type Error struct {
	Status  int
	Message string
	Path    string
}

func (e *Error) Error() string { return e.Message }

// Client is one connection to Branch Agent.
type Client struct {
	URL       string
	token     string
	http      *http.Client
	Runs      *Runs
	Sessions  *Sessions
	Memory    *Memory
	Documents *Documents
	Schedules *Schedules
	Policy    *Policy
	Flows     *Flows
}

// New makes a client for the app at url with its session key.
//
// The key is the whole of the app's security, so it is only sent over plain http to this
// computer's own address (https for anything else), a redirect is never followed, and any proxy
// set in the environment is ignored.
func New(address, token string) (*Client, error) {
	if address == "" || token == "" {
		return nil, errors.New("give the address Branch Agent is listening on and its session key")
	}
	checked, err := checkURL(address)
	if err != nil {
		return nil, err
	}
	client := &Client{URL: checked, token: token, http: &http.Client{
		Timeout:   2 * time.Minute,
		Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
	client.Runs = &Runs{client}
	client.Sessions = &Sessions{client}
	client.Memory = &Memory{client}
	client.Documents = &Documents{client}
	client.Schedules = &Schedules{client}
	client.Policy = &Policy{client}
	client.Flows = &Flows{client}
	return client, nil
}

// FromDataDir reads the key the app wrote for this install, so a program needs no configuration.
// A port of 0 means DefaultPort.
func FromDataDir(dataDir string, port int) (*Client, error) {
	raw, err := os.ReadFile(filepath.Join(dataDir, "session-token"))
	if err != nil {
		return nil, fmt.Errorf("the session key could not be read from %s: %w", dataDir, err)
	}
	if port == 0 {
		port = DefaultPort
	}
	return New(fmt.Sprintf("http://127.0.0.1:%d", port), strings.TrimSpace(string(raw)))
}

// String never shows the key.
func (c *Client) String() string { return fmt.Sprintf("branch.Client(%s)", c.URL) }

func checkURL(address string) (string, error) {
	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return "", errors.New("give the web address Branch Agent is listening on, starting with http:// or https://")
	}
	if parsed.Scheme == "http" && !isLocal(parsed.Hostname()) {
		return "", errors.New("plain http is only used for a Branch Agent on this computer; use https for any other address")
	}
	return strings.TrimRight(address, "/"), nil
}

func isLocal(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// segment writes one id into an address, so it can never reach a different route.
func segment(value string) string { return url.PathEscape(value) }

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.URL+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

// Request sends one request and decodes the answer into an Object. A reply that is not a success
// becomes an *Error. Nothing is retried.
func (c *Client) Request(ctx context.Context, method, path string, body any) (Object, error) {
	request, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, &Error{Status: 0, Message: "Branch Agent could not be reached: " + err.Error(), Path: path}
	}
	defer response.Body.Close()
	text, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return nil, &Error{Status: 0, Message: "the answer could not be read: " + err.Error(), Path: path}
	}
	value := readJSON(text)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		message, _ := value["error"].(string)
		if message == "" {
			message = fmt.Sprintf("Branch Agent answered %d", response.StatusCode)
		}
		return nil, &Error{Status: response.StatusCode, Message: message, Path: path}
	}
	return value, nil
}

func readJSON(text []byte) Object {
	if len(bytes.TrimSpace(text)) == 0 {
		return Object{}
	}
	var value any
	if err := json.Unmarshal(text, &value); err != nil {
		return Object{"error": string(text[:min(len(text), 300)])}
	}
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return Object{"value": value}
}

// Get reads one address.
func (c *Client) Get(ctx context.Context, path string) (Object, error) {
	return c.Request(ctx, http.MethodGet, path, nil)
}

// Post sends a body (an empty object when body is nil).
func (c *Client) Post(ctx context.Context, path string, body any) (Object, error) {
	if body == nil {
		body = Object{}
	}
	return c.Request(ctx, http.MethodPost, path, body)
}

// State is everything the app knows about itself right now.
func (c *Client) State(ctx context.Context) (Object, error) { return c.Get(ctx, "/api/state") }

// Tools is every tool this copy can run, with the permission each one needs.
func (c *Client) Tools(ctx context.Context) (Object, error) { return c.Get(ctx, "/api/tools") }

// OpenAPI is the app's own description of its web API.
func (c *Client) OpenAPI(ctx context.Context) (Object, error) { return c.Get(ctx, "/api/openapi.json") }

// Audit is the record of what the assistant was allowed to do, narrowed by filters.
func (c *Client) Audit(ctx context.Context, filters map[string]string) (Object, error) {
	query := url.Values{}
	for name, value := range filters {
		if value != "" {
			query.Set(name, value)
		}
	}
	path := "/api/audit"
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	return c.Get(ctx, path)
}

// Action runs one tool directly, without a task around it.
func (c *Client) Action(ctx context.Context, tool string, args Object) (Object, error) {
	if args == nil {
		args = Object{}
	}
	return c.Post(ctx, "/api/action", Object{"tool": tool, "args": args})
}

// Search looks through documents and saved notes together, best answer first.
func (c *Client) Search(ctx context.Context, query string) (Object, error) {
	return c.Post(ctx, "/api/retrieval/search", Object{"query": query})
}

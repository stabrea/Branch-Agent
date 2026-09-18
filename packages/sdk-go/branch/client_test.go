package branch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type seen struct {
	method, path, query, auth, contentType string
	body                                   Object
}

// fake answers every request with reply and remembers what it was sent.
func fake(t *testing.T, reply func(w http.ResponseWriter, r *http.Request)) (*Client, *[]seen) {
	t.Helper()
	calls := &[]seen{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body Object
		_ = json.Unmarshal(raw, &body)
		*calls = append(*calls, seen{r.Method, r.URL.EscapedPath(), r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), body})
		reply(w, r)
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL+"/", "secret-key")
	if err != nil {
		t.Fatal(err)
	}
	return client, calls
}

func ok(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"ok":true}`) }

func TestNewRefusesMissingPartsAndPlainHTTPElsewhere(t *testing.T) {
	cases := map[string][2]string{
		"no key":         {"http://127.0.0.1:3210", ""},
		"no address":     {"", "abc"},
		"not the web":    {"ftp://127.0.0.1", "abc"},
		"plain http out": {"http://example.com:3210", "abc"},
	}
	for name, input := range cases {
		if _, err := New(input[0], input[1]); err == nil {
			t.Errorf("%s: expected a refusal", name)
		}
	}
	for _, address := range []string{"http://localhost:3210", "http://[::1]:3210", "https://branch.example.com"} {
		if _, err := New(address, "abc"); err != nil {
			t.Errorf("%s: %v", address, err)
		}
	}
	client, _ := New("http://127.0.0.1:3210/", "abc")
	if client.URL != "http://127.0.0.1:3210" || strings.Contains(client.String(), "abc") {
		t.Errorf("address kept without its slash, key never shown: %s", client)
	}
}

func TestRequestsCarryTheKeyAndTheRightAddress(t *testing.T) {
	client, calls := fake(t, ok)
	ctx := context.Background()
	steps := []func() (Object, error){
		func() (Object, error) { return client.Runs.Start(ctx, "Summarise", Object{"temporary": true}) },
		func() (Object, error) { return client.Runs.Get(ctx, "a/../b") },
		func() (Object, error) { return client.Runs.Steer(ctx, "r1", "shorter") },
		func() (Object, error) { return client.Memory.Search(ctx, "Northgate", 5) },
		func() (Object, error) { return client.Documents.Remove(ctx, "d1") },
		func() (Object, error) { return client.Policy.Approve(ctx, "s1", "allow", "") },
		func() (Object, error) {
			return client.Audit(ctx, map[string]string{"action": "secret.used", "empty": ""})
		},
		func() (Object, error) { return client.Flows.ImportYAML(ctx, "name: x") },
	}
	for _, step := range steps {
		if _, err := step(); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"POST /api/run", "GET /api/runs/a%2F..%2Fb", "POST /api/runs/r1/steer", "POST /api/memory/search",
		"DELETE /api/documents/d1", "POST /api/policy/approve", "GET /api/audit", "POST /api/flows/yaml"}
	for i, call := range *calls {
		if got := call.method + " " + call.path; got != want[i] {
			t.Errorf("call %d: got %s, want %s", i, got, want[i])
		}
		if call.auth != "Bearer secret-key" {
			t.Errorf("call %d did not carry the key", i)
		}
	}
	first := (*calls)[0]
	if first.body["prompt"] != "Summarise" || first.body["temporary"] != true || first.contentType != "application/json" {
		t.Errorf("start body: %v", first.body)
	}
	if (*calls)[5].body["remember"] != "session" || (*calls)[6].query != "action=secret.used" {
		t.Errorf("defaults and filters: %v %q", (*calls)[5].body, (*calls)[6].query)
	}
}

func TestRefusalsCarryTheAppsOwnWords(t *testing.T) {
	client, _ := fake(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"error":"Run not found"}`)
	})
	_, err := client.Runs.Get(context.Background(), "nope")
	var refused *Error
	if !errors.As(err, &refused) || refused.Status != 404 || refused.Message != "Run not found" || refused.Path != "/api/runs/nope" {
		t.Fatalf("got %#v", err)
	}
	down, _ := New("http://127.0.0.1:1", "k")
	_, err = down.State(context.Background())
	if !errors.As(err, &refused) || refused.Status != 0 {
		t.Fatalf("an app that is not running gives status 0: %#v", err)
	}
}

func TestARedirectIsNeverFollowed(t *testing.T) {
	followed := false
	client, _ := fake(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed = true
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	})
	_, err := client.State(context.Background())
	var refused *Error
	if followed || !errors.As(err, &refused) || refused.Status != http.StatusFound {
		t.Fatalf("followed=%v err=%#v", followed, err)
	}
}

func TestStreamReadsEventsUntilTheEnd(t *testing.T) {
	client, calls := fake(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, "event: tool.started\ndata: {\"id\":1,\"data\":{\"label\":\"Reading\"}}\n\n: comment\n\nevent: end\ndata: {\"status\":\"completed\"}\n\n")
	})
	kinds := []string{}
	for event, err := range client.Runs.Stream(context.Background(), "r1", 7) {
		if err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, event.Kind)
	}
	if strings.Join(kinds, ",") != "tool.started,end" || (*calls)[0].query != "after=7" {
		t.Fatalf("kinds %v query %q", kinds, (*calls)[0].query)
	}
}

func TestFromDataDirReadsTheKeyAndExportYAMLReadsTheText(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "session-token"), []byte("from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := FromDataDir(dir, 0)
	if err != nil || client.URL != "http://127.0.0.1:3210" || client.token != "from-file" {
		t.Fatalf("%v %v", client, err)
	}
	served, _ := fake(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"yaml":"name: Tidy\n"}`) })
	text, err := served.Flows.ExportYAML(context.Background(), "f1")
	if err != nil || text != "name: Tidy\n" {
		t.Fatalf("%q %v", text, err)
	}
}

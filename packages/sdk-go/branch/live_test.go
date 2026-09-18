package branch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestLive drives a real Branch Agent. It runs only when tests/sdk-go.test.mjs starts one and
// says where (BRANCH_DATA_DIR and BRANCH_PORT); it prints what it saw as one JSON line.
func TestLive(t *testing.T) {
	dataDir, port := os.Getenv("BRANCH_DATA_DIR"), os.Getenv("BRANCH_PORT")
	if dataDir == "" || port == "" {
		t.Skip("no Branch Agent to drive")
	}
	number, _ := strconv.Atoi(port)
	client, err := FromDataDir(dataDir, number)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	out := map[string]any{}
	started, err := client.Runs.Start(ctx, "Summarise the meeting notes", nil)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := started["id"].(string)
	kinds := []string{}
	for event, err := range client.Runs.Stream(ctx, runID, 0) {
		if err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, event.Kind)
	}
	out["kinds"] = kinds
	finished, err := client.Runs.Get(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	out["output"] = finished["run"].(map[string]any)["output"]
	liveReadsAndRefusals(t, ctx, client, out)
	line, _ := json.Marshal(out)
	fmt.Println("LIVE " + string(line))
}

func liveReadsAndRefusals(t *testing.T, ctx context.Context, client *Client, out map[string]any) {
	t.Helper()
	if _, err := client.Documents.Add(ctx, "Notes", "The Northgate invoice is due on Friday."); err != nil {
		t.Fatal(err)
	}
	found, err := client.Search(ctx, "Northgate invoice")
	if err != nil {
		t.Fatal(err)
	}
	out["found"] = len(found["passages"].([]any))
	described, err := client.OpenAPI(ctx)
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for path := range described["paths"].(map[string]any) {
		paths = append(paths, path)
	}
	out["described"] = strings.Join(paths, " ")
	var refused *Error
	if _, err := client.Runs.Get(ctx, "00000000-0000-0000-0000-000000000000"); errors.As(err, &refused) {
		out["refused"] = []any{refused.Status, refused.Message}
	}
	wrong, _ := New(client.URL, strings.Repeat("0", 64))
	if _, err := wrong.State(ctx); errors.As(err, &refused) {
		out["wrongKey"] = refused.Status
	}
	_, err = client.Flows.ExportYAML(ctx, "00000000-0000-4000-8000-000000000000")
	if errors.As(err, &refused) {
		out["yamlOff"] = []any{refused.Status, refused.Message}
	}
}

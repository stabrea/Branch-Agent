package branch

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"net/http"
	"strings"
)

// Event is one thing that happened in a task. Kind is the event's name; the last one of a task is
// "end" and carries only the status.
type Event struct {
	Kind string
	Data Object
}

// Stream reads a task's events as they happen and stops when the task does. Start from after to
// pick up where an earlier read stopped. Stop early by breaking out of the loop or cancelling ctx.
//
//	for event, err := range client.Runs.Stream(ctx, runID, 0) {
//		if err != nil { return err }
//		fmt.Println(event.Kind)
//	}
func (r *Runs) Stream(ctx context.Context, runID string, after int) iter.Seq2[Event, error] {
	return func(yield func(Event, error) bool) {
		path := "/api/runs/" + segment(runID) + "/stream"
		request, err := r.c.newRequest(ctx, http.MethodGet, fmt.Sprintf("%s?after=%d", path, after), nil)
		if err != nil {
			yield(Event{}, err)
			return
		}
		request.Header.Set("Accept", "text/event-stream")
		// The same no-proxy, no-redirect client, without the overall time limit a stream would hit.
		streaming := *r.c.http
		streaming.Timeout = 0
		response, err := streaming.Do(request)
		if err != nil {
			yield(Event{}, &Error{Status: 0, Message: "Branch Agent could not be reached: " + err.Error(), Path: path})
			return
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			yield(Event{}, &Error{Status: response.StatusCode, Message: "That task's events could not be read", Path: path})
			return
		}
		readFrames(response, yield)
	}
}

// readFrames turns server-sent frames back into the events they carried.
func readFrames(response *http.Response, yield func(Event, error) bool) {
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	name, data := "", []string{}
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		switch {
		case line == "":
			if event, ok := frame(name, data); ok && !yield(event, nil) {
				return
			}
			name, data = "", nil
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimSpace(line[5:]))
		}
	}
	if event, ok := frame(name, data); ok && !yield(event, nil) {
		return
	}
	if err := scanner.Err(); err != nil {
		yield(Event{}, err)
	}
}

func frame(name string, data []string) (Event, bool) {
	if len(data) == 0 {
		return Event{}, false
	}
	var value Object
	if err := json.Unmarshal([]byte(strings.Join(data, "\n")), &value); err != nil || value == nil {
		return Event{}, false
	}
	if kind, ok := value["kind"].(string); name == "" && ok {
		name = kind
	}
	return Event{Kind: name, Data: value}, true
}

/**
 * The Branch Agent client for React, as hooks around the plain client in packages/sdk.
 *
 * Nothing here imports React: `createBranchHooks(React)` is handed the React a page already has,
 * which keeps this package free of dependencies and lets its tests run with no React installed.
 * `index.mjs` does the handing-over for a page that imports "react" the ordinary way.
 */

const idle = Object.freeze({ runId: null, status: "idle", events: Object.freeze([]), output: "", error: null });

/**
 * One task's life, kept outside React so any number of components can watch it: start it, read
 * its events as they arrive, then read the finished answer. `subscribe` and `snapshot` are what
 * `useSyncExternalStore` wants.
 */
export function createRunStore(client) {
  let state = idle;
  let controller = null;
  const listeners = new Set();
  const set = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };
  async function follow(runId, signal) {
    for await (const event of client.runs.stream(runId, { signal })) {
      if (signal.aborted) return;
      set({ events: Object.freeze([...state.events, event]) });
    }
    const finished = await client.runs.get(runId);
    if (!signal.aborted) set({ status: finished.run?.status ?? "completed", output: finished.run?.output ?? "" });
  }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => state,
    async start(prompt, input = {}) {
      controller?.abort();
      const current = (controller = new AbortController());
      set({ ...idle, status: "starting" });
      try {
        const run = await client.runs.start({ ...input, prompt });
        if (current.signal.aborted) return run;
        set({ runId: run.id, status: "running" });
        await follow(run.id, current.signal);
        return run;
      } catch (error) {
        if (!current.signal.aborted) set({ status: "failed", error });
        return null;
      }
    },
    steer: (text) => (state.runId ? client.runs.steer(state.runId, text) : Promise.resolve(null)),
    async cancel() {
      const runId = state.runId;
      controller?.abort();
      if (runId) await client.runs.cancel(runId);
      set({ status: "cancelled" });
    },
    /** Stops reading without stopping the task, as when the component showing it goes away. */
    detach() { controller?.abort(); },
  };
}

/** Everything a page needs, built on the React it hands in. */
export function createBranchHooks(React) {
  const { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } = React;
  const BranchContext = createContext(null);

  /** Puts one client within reach of every component below it. */
  function BranchProvider({ client, children }) {
    return createElement(BranchContext.Provider, { value: client }, children);
  }

  /** The client from the nearest BranchProvider. */
  function useBranch() {
    const client = useContext(BranchContext);
    if (!client) throw new Error("useBranch needs a <BranchProvider client={...}> above it");
    return client;
  }

  /** Reads one address, again whenever `path` changes, and again on `refresh()` or every `everyMs`. */
  function useBranchGet(path, { everyMs = 0 } = {}) {
    const client = useBranch();
    const [state, setState] = useState({ data: null, error: null, loading: path !== null });
    const [turn, setTurn] = useState(0);
    const refresh = useCallback(() => setTurn((value) => value + 1), []);
    useEffect(() => {
      if (path === null) return undefined;
      let live = true;
      setState((previous) => ({ ...previous, loading: true }));
      client.get(path).then(
        (data) => { if (live) setState({ data, error: null, loading: false }); },
        (error) => { if (live) setState((previous) => ({ data: previous.data, error, loading: false })); });
      const timer = everyMs > 0 ? setInterval(refresh, everyMs) : null;
      return () => { live = false; if (timer) clearInterval(timer); };
    }, [client, path, turn, everyMs, refresh]);
    return { ...state, refresh };
  }

  /** Starts a task and follows it: its events as they come, then its answer. */
  function useBranchRun() {
    const client = useBranch();
    const store = useMemo(() => createRunStore(client), [client]);
    useEffect(() => () => store.detach(), [store]);
    const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
    return { ...state, start: store.start, steer: store.steer, cancel: store.cancel };
  }

  return { BranchContext, BranchProvider, useBranch, useBranchGet, useBranchRun };
}

# Common Rules and Patterns

## Testing Patterns

### Avoiding Silent Dependencies on Machine Speed

Tests should never depend on wall-clock timing without deliberate control. A test that relies on elapsed time between tool calls can pass on a fast machine and fail intermittently on CI because the machine is slower.

**The problem:** If a test measures elapsed time (e.g., checking that a tool call completed within a rate-limit window), on fast machines the calls happen close enough together; on slow CI machines, the elapsed time exceeds expectations and the test fails.

**Example:** A rate-limit test that sets a 1000ms window and checks that two tool calls are rate-limited. On a developer's machine, both calls land within the window and the test passes. On slow CI, more than 1000ms elapses between the calls, the first call ages out of the window, and the test fails incorrectly.

**The fix:** Use constructor-injected clock functions instead of wall-clock time. Pass a controlled clock to the component being tested so that time can be deterministic:

```typescript
// BAD: wall-clock timing, machine speed dependent
test("rate limit", async (t) => {
  const { app } = await served(t, steps, { /* no clock */ });
  const origComplete = provider.complete.bind(provider);
  let callNumber = 0;
  provider.complete = async (request) => {
    const result = await origComplete(request);
    if (result.toolCalls?.length) callNumber++;
    return result;
  };
  // Between origComplete calls, time passes. On slow CI, > 1000ms elapses.
  // Test fails if the window ages out between calls.
});

// GOOD: constructor-injected clock, deterministic
test("rate limit", async (t) => {
  let callNumber = 0;
  const baseTime = 10000;
  const testClock = () => baseTime + (callNumber * 500);
  
  const { app } = await served(t, steps, { 
    reliability: { rateWindowMs: 1000 },
    clock: testClock,  // Inject the clock
  });
  
  const origComplete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    const result = await origComplete(request);
    if (result.toolCalls?.length) callNumber++;  // Increments the clock
    return result;
  };
  // Clock is controlled; first call at T=10000, second at T=10500.
  // Both are within the 1000ms window. Test passes consistently.
});
```

**Pattern:** Components that use `Date.now()` should accept an optional clock function parameter in their constructor (defaulting to `Date.now`). Tests can pass a controlled clock; production uses the real clock. Never use mutable fields (like `testNow`) as escape hatches; they silently break rate limiting if set and not cleared.

### Rationale

Rate limiting, timeouts, and other time-dependent behavior must work correctly on slow machines. A test that passes only on fast machines is a test that does not verify the behavior. Constructor injection of clock functions provides determinism without mutable escape hatches that can be forgotten or accidentally left set.

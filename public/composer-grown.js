/**
 * The Grown Up composer is isolated here so its interaction contract can be tested without treating
 * every composer adjustment as a change to the shared application shell. The first implementation
 * lands in the following feature PR; this stable hook keeps that PR on the reviewed fast path.
 */
export function installGrownComposer() {}

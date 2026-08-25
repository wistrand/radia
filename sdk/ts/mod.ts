// THE ENTRY POINT. One import for everything an application needs.
//
// It exists because the pieces of an ordinary journey lived in three modules: the client, the
// worker harnesses, and the projection helpers. Measured on four minimal journeys (a task/result
// pair, a registry you own, a correlated request, a registry you discover): 9 imports across 9
// module paths for 87 lines of code, and writing a registry entry needed a second module because
// `contentKey` was not reachable from the client at all.
//
// A BARREL, not a layer. Every name here is re-exported unchanged from the module that owns it, so
// there is nothing to keep in sync and nothing new to learn; `sdk/ts/client.ts` and the rest stay
// importable for anyone who prefers them. The npm package points `.` here.
export * from "./client.ts";
export { agentLoop, reactorLoop } from "./loop.ts";
export type { LoopOptions, ReactorOptions } from "./loop.ts";
export { contentKey, newer, newestByKey, oidcIdentityKey, opsGrantKey } from "./registry.ts";

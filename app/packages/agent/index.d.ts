// Types for `meteor/10thfloor:agent`.
//
// `./types/` is generated from source (`npm run types`). This file is the only
// hand-written part — it exists because the package has two mainModules and one
// import id.
//
// The default `Agent` is the server class (configs, tools, gates, hooks). Client
// code imports `ClientAgent` for the browser surface (subscribe, messages,
// status, pending). Trade-off: a client file can import a server-only export
// and type-check fine, then fail at run time.

export * from './types/server/index';

// The `<agent-chat>` element. Client-only.
export { defineAgentChat } from './types/client/element';

// Browser-side `Agent` under its own name. Same class at run time; the alias
// lets both surfaces be imported from one module id.
export { Agent as ClientAgent } from './types/client/agent';

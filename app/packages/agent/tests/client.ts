// Client-side tests. Only what genuinely needs a BROWSER belongs here — the
// live DDP round trip and the custom element — because keeping every other
// test server-only is what stops server modules reaching the client bundle,
// and keeps the reported test counts in this plan meaningful.
//
// Order matters: both files drive the same `itest` fixtures over one DDP
// connection, and `element.client.ts` resets the transcript when it starts.
import './integration.client';
import './element.client';

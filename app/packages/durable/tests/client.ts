// Client-side tests. Only what genuinely needs a BROWSER belongs here: the
// live DDP round trip through `DurableConversation`. Keeping every other test
// server-only is what stops server modules reaching the client bundle.
import './integration.client';

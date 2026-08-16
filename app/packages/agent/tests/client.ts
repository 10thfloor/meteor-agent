// Client-side tests. Only the live DDP round trip belongs here: keeping every
// other test server-only is what stops server modules reaching the client
// bundle, and keeps the reported test counts in this plan meaningful.
import './integration.client';

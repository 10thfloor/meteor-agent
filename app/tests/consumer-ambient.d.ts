/** `10thfloor:durable`'s declarations name Pi Durable's types, which name
 * pi-ai's, which import `@google/genai`'s. Those import one type from an
 * optional peer that pi-ai does not install. The consumer check runs with
 * `skipLibCheck: false` so that our own generated declarations are checked, and
 * that makes the missing peer an error; an app that checks its libraries the
 * same way needs this same declaration (or the peer installed). */
declare module '@modelcontextprotocol/sdk/client/index.js' {
  export interface Client {}
}

// Native ESM entry: private assets are not rewritten by Meteor's CJS compiler.
export const load = (url) => import(url);

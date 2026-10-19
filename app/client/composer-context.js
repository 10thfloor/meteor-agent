// App-owned context modules share the one empty-submit flag. Capturing the
// baseline once avoids one module's repaint or teardown disabling another.
const contexts = new WeakMap();

export function registerComposerContext(chat) {
  let state = contexts.get(chat);
  if (!state) {
    state = { baseline: chat.allowEmptySubmit, channels: new Map() };
    contexts.set(chat, state);
  }
  const channel = Symbol('composer-context');
  state.channels.set(channel, false);
  let disposed = false;
  const update = () => {
    chat.allowEmptySubmit = state.baseline || [...state.channels.values()].some(Boolean);
  };
  return {
    set(active) {
      if (disposed) return;
      state.channels.set(channel, !!active);
      update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.channels.delete(channel);
      update();
      if (!state.channels.size) contexts.delete(chat);
    },
  };
}

import './mission-work-navigation.css';

/** Switches existing panels without remounting the chat or losing its draft. */
export function initializeMissionWorkNavigation({ root, onChange, onTabChange } = {}) {
  const tabs = [...root.querySelectorAll('[data-mission-work-tab]')];
  const panels = [...root.querySelectorAll('[data-mission-work-panel]')];
  const selections = new Map();
  let missionId = null; let tab = 'chat'; let visible = true;
  let disposed = false;
  function paint() {
    for (const button of tabs) {
      const selected = button.dataset.missionWorkTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = !missionId && button.dataset.missionWorkTab !== 'chat';
    }
    for (const panel of panels) panel.hidden = panel.dataset.missionWorkPanel !== tab;
    root.dataset.missionWork = tab;
    onTabChange?.(tab);
  }
  function notify(options) {
    onChange?.({ missionId, tab: visible ? tab : 'chat', options });
  }
  function show(next, options, { focus = false } = {}) {
    if (disposed || !tabs.some((button) => button.dataset.missionWorkTab === next)
      || (!missionId && next !== 'chat')) return false;
    const changed = tab !== next;
    tab = next;
    if (missionId) selections.set(missionId, tab);
    paint();
    if (changed || options) notify(options);
    if (focus) tabs.find((button) => button.dataset.missionWorkTab === tab)?.focus({ preventScroll: true });
    return true;
  }
  function click(event) {
    const button = event.target.closest('[data-mission-work-tab]');
    if (button && root.contains(button) && !button.disabled) show(button.dataset.missionWorkTab);
  }
  function keydown(event) {
    const button = event.target.closest('[data-mission-work-tab]');
    if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const available = tabs.filter((item) => !item.disabled);
    const index = available.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
    event.preventDefault();
    show(available[next].dataset.missionWorkTab, undefined, { focus: true });
  }
  root.addEventListener('click', click); root.addEventListener('keydown', keydown);
  paint();
  return {
    show,
    setMission(id) {
      if (disposed || missionId === (id || null)) return;
      missionId = id || null; tab = selections.get(missionId) || 'chat';
      paint(); notify();
    },
    setVisible(next) {
      if (disposed || visible === Boolean(next)) return;
      visible = Boolean(next); notify();
    },
    get activeTab() { return tab; },
    dispose() { disposed = true; selections.clear(); root.removeEventListener('click', click); root.removeEventListener('keydown', keydown); },
  };
}

// The #topic chip beside the Mission title, and its menu: rename or archive this topic, add one, or bring an archived
// topic back. #general can't be renamed or archived; it is the Mission's own conversation.
import { GENERAL_TOPIC, normalizeTopicName, topicLabel, topicNameProblem } from '../imports/constellation/topics';

export function initializeTopicMenu({ details, summary, name, list, state, actions }) {
  let renaming = false;
  const close = ({ focus = true } = {}) => {
    details.open = false;
    renaming = false;
    if (focus) summary.focus();
  };
  const item = (label, onClick, { disabled = false, title = '' } = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.disabled = disabled;
    if (title) button.title = title;
    button.addEventListener('click', async () => {
      close();
      try { await onClick(); } catch (error) { actions.toast(error?.reason ?? error?.message ?? 'Something went wrong.', 'error'); }
    });
    return button;
  };
  const renameForm = (current) => {
    const form = document.createElement('form');
    form.className = 'topic-rename-form';
    form.noValidate = true;
    const label = document.createElement('label');
    label.textContent = 'Rename topic';
    const field = document.createElement('span');
    field.className = 'topic-add-field';
    const hash = document.createElement('span');
    hash.className = 'topic-hash';
    hash.textContent = '#';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current.name;
    input.maxLength = 60;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Topic name');
    field.append(hash, input);
    label.append(field);
    const hint = document.createElement('small');
    hint.className = 'topic-add-hint';
    hint.textContent = 'Enter to save · Esc to cancel';
    form.append(label, hint);
    const problem = () => {
      const clean = normalizeTopicName(input.value);
      return clean === current.name ? null : topicNameProblem(clean, current.taken);
    };
    input.addEventListener('input', () => {
      const issue = problem();
      const clean = normalizeTopicName(input.value);
      hint.textContent = issue ?? (clean && clean !== input.value.trim() ? `Will be #${clean}` : 'Enter to save · Esc to cancel');
      form.classList.toggle('invalid', Boolean(issue));
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const clean = normalizeTopicName(input.value);
      if (problem()) { input.focus(); return; }
      if (clean === current.name) { close(); return; }
      input.readOnly = true;
      hint.textContent = 'Saving…';
      try {
        await actions.rename(current.sessionId, clean);
        close();
      } catch (error) {
        input.readOnly = false;
        hint.textContent = error?.reason ?? error?.message ?? 'Could not rename the topic.';
        form.classList.add('invalid');
        input.focus();
      }
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return form;
  };

  const render = () => {
    const current = state();
    name.textContent = current.name;
    summary.setAttribute('aria-label', `${topicLabel(current.name)}, topic actions`);
    if (!details.open) return;
    list.textContent = '';
    if (renaming && current.name !== GENERAL_TOPIC) { list.append(renameForm(current)); return; }
    const general = current.name === GENERAL_TOPIC;
    const fixed = '#general is the Mission’s own conversation.';
    list.append(
      item('Rename topic', () => { renaming = true; details.open = true; render(); }, { disabled: general, title: general ? fixed : '' }),
      item('Archive topic', () => actions.archive(current.sessionId), { disabled: general, title: general ? fixed : 'Stops its work and takes it off the list. You can bring it back.' }),
      item('Add topic', () => actions.add(current.missionId)),
    );
    if (current.archived.length) {
      const heading = document.createElement('p');
      heading.className = 'topic-menu-heading';
      heading.textContent = 'Archived topics';
      list.append(heading, ...current.archived.map((topic) => (
        item(`Restore ${topicLabel(topic.name)}`, () => actions.unarchive(topic._id)))));
    }
  };

  details.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(details.open));
    if (!details.open) { renaming = false; return; }
    render();
    if (!renaming) requestAnimationFrame(() => list.querySelector('[role="menuitem"]:not(:disabled)')?.focus());
  });
  document.addEventListener('click', (event) => {
    if (details.open && !details.contains(event.target)) close({ focus: false });
  });
  details.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && details.open) { event.preventDefault(); close(); return; }
    if (renaming || !details.open || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...list.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? items[0]
      : event.key === 'End' ? items.at(-1)
        : items[(Math.max(0, at) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next.focus();
  });
  return { render };
}

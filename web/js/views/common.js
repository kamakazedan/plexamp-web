// What several pages use: lists in words, radio buttons that work from the
// keyboard, and the attributes that keep a secret out of password managers.

// "A", "A and B", "A, B and C".
export function joinWithAnd(list) {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

// A group of buttons with role=radio (in a role=radiogroup), as a set of
// radio buttons works from the keyboard: Tab goes to the chosen one, and
// the arrow keys move to the one before or after it (round from the end),
// choosing it. Each button's own click chooses it, as before.
export function radioArrowKeys(group) {
  const radios = () => [...group.querySelectorAll('[role="radio"]')];
  const tabStop = () => {
    const all = radios();
    const chosen = all.find((r) => r.getAttribute('aria-checked') === 'true') || all[0];
    for (const r of all) r.tabIndex = r === chosen ? 0 : -1;
  };
  const STEPS = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  group.addEventListener('keydown', (e) => {
    const all = radios();
    const at = e.key in STEPS ? all.indexOf(e.target.closest?.('[role="radio"]')) : -1;
    if (at < 0) return;
    e.preventDefault();
    const next = all[(at + STEPS[e.key] + all.length) % all.length];
    next.click();
    next.focus();
  });
  // (After the button's own click has said which is chosen.)
  group.addEventListener('click', tabStop);
  tabStop();
  return group;
}

// For an input that holds a secret (a token, a key): never offered to the
// browser's keeping, or a password manager's (the browser's own is told
// it's a code), as the PIN dialog's isn't (ui.js askText).
export const SECRET_INPUT = { autocomplete: 'one-time-code', spellcheck: 'false', 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-bwignore': true, 'data-form-type': 'other' };

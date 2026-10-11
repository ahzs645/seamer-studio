/** Visible controls only: collapsed controls must never receive keyboard focus. */
export function focusableControls(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
  )).filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
}

/** Keep Tab inside a modal, including at the native dialog's document boundary. */
export function containModalTab(event: KeyboardEvent, container: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const controls = focusableControls(container);
  const first = controls[0], last = controls.at(-1);
  if (!first) { event.preventDefault(); container.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
}

/** Menus use arrow keys and Home/End; Tab remains ordinary document navigation. */
export function navigateMenu(event: KeyboardEvent, menu: HTMLElement): void {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
    current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) :
    (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[index].focus({ preventScroll: true });
  items[index].scrollIntoView({ block: 'nearest' });
}

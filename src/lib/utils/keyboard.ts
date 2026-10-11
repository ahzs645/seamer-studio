/** Text controls retain their own keyboard behavior, including nested editable children. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return editable instanceof HTMLElement && editable.isContentEditable;
}

/** Production-table focus belongs to Specs even when a drawing pane is still visible. */
export function isSpecsKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-keyboard-scope="specs"]'));
}

/** Dialogs keep app shortcuts from acting on the pattern underneath them. */
export function isDialogKeyboardTarget(target: EventTarget | null): boolean {
  return Boolean(
    Array.from(document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden])'))
      .some((dialog) => dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden') ||
    (target instanceof Element && target.closest('dialog[open], [role="dialog"]'))
  );
}

/** Use only for app actions; Escape dismissal remains with the dialog itself. */
export function isAppShortcutBlocked(event: KeyboardEvent): boolean {
  return event.defaultPrevented || event.isComposing ||
    isEditableKeyboardTarget(event.target) || isDialogKeyboardTarget(event.target);
}

/** The 3D pane owns shortcuts while hovered or when keyboard focus is inside it. */
export function scene3dOwnsKeyboard(): boolean {
  return Boolean(
    document.querySelector('[data-testid="pattern-scene-3d"]:hover') ||
    document.activeElement?.closest('[data-testid="pattern-scene-3d"]')
  );
}

/** Shared guard for single-key 2D drawing shortcuts. Shift is checked by each binding. */
export function canUseDrawingShortcut(event: KeyboardEvent): boolean {
  return !isAppShortcutBlocked(event) && !isSpecsKeyboardTarget(event.target) &&
    !event.metaKey && !event.ctrlKey && !event.altKey && !scene3dOwnsKeyboard();
}

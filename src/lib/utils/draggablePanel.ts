// Svelte action making a floating overlay panel draggable by its header (the source's
// FloatingPanel drag handle). Apply with `use:draggablePanel={{ handle: '[data-drag-handle]' }}`;
// the matched child becomes the grab area. Position is a transient transform (not persisted).

export function draggablePanel(node: HTMLElement, opts: { handle?: string } = {}) {
  let dx = 0, dy = 0;
  let sx = 0, sy = 0, bx = 0, by = 0;
  let dragging = false;
  const handle = (opts.handle ? node.querySelector<HTMLElement>(opts.handle) : null) ?? node;
  handle.style.cursor = 'move';
  handle.style.touchAction = 'none';

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // don't hijack clicks on interactive controls inside the handle
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY; bx = dx; by = dy;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (!dragging) return;
    dx = bx + e.clientX - sx;
    dy = by + e.clientY - sy;
    node.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const up = () => { dragging = false; };

  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
  return {
    destroy() {
      handle.removeEventListener('pointerdown', down);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    }
  };
}

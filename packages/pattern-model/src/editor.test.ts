import { createDoc, Editor, Selection } from '@atelier/core';
import { describe, expect, it } from 'vitest';
import { createPatternRegistry } from './commands/registry';
import { createEmptyPattern } from './pattern';

function editor(now: () => number = Date.now): Editor<ReturnType<typeof createEmptyPattern>> {
  const pattern = createEmptyPattern();
  pattern.points = [
    { id: 'a', name: 'A', x: 0, y: 0 },
    { id: 'b', name: 'B', x: 10, y: 0 }
  ];
  return new Editor(createDoc(pattern, { id: 'pattern-test' }), {
    registry: createPatternRegistry(),
    history: { now, coalesceMs: 800 }
  });
}

describe('Pattern Editor integration', () => {
  it('executes a typed command with a label and supports undo/redo', () => {
    const instance = editor();
    const result = instance.execute('point.move', { pointId: 'a', x: 25, y: 5 });
    expect(result).toEqual({ ok: true, changed: true });
    expect(instance.content.points[0]).toMatchObject({ x: 25, y: 5 });
    expect(instance.undoLabel).toBe('Move point');
    expect(instance.undo()).toBe(true);
    expect(instance.content.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(instance.redo()).toBe(true);
    expect(instance.content.points[0]).toMatchObject({ x: 25, y: 5 });
  });

  it('uses Atelier Selection for batch transforms', () => {
    const instance = editor();
    instance.setSelection(Selection.of([['point', ['a', 'b']]]));
    instance.execute('selection.move', { dx: 5, dy: -2 });
    expect(instance.content.points.map(({ x, y }) => [x, y])).toEqual([
      [5, -2],
      [15, -2]
    ]);
  });

  it('coalesces repeated drag labels inside the 800 ms gesture window', () => {
    let clock = 1_000;
    const instance = editor(() => clock);
    instance.execute('point.move', { pointId: 'a', x: 1, y: 0 });
    clock += 100;
    instance.execute('point.move', { pointId: 'a', x: 2, y: 0 });
    expect(instance.historyLabels).toEqual(['Move point']);
    expect(instance.undo()).toBe(true);
    expect(instance.content.points[0].x).toBe(0);
  });

  it('commits a multi-command transaction as one history entry', () => {
    const instance = editor();
    const transaction = instance.transaction('Drag point');
    transaction.execute('point.move', { pointId: 'a', x: 4, y: 0 });
    transaction.execute('point.move', { pointId: 'a', x: 9, y: 3 });
    expect(transaction.commit()).toBe(true);
    expect(instance.historyLabels).toEqual(['Drag point']);
    expect(instance.undo()).toBe(true);
    expect(instance.content.points[0]).toMatchObject({ x: 0, y: 0 });
  });
});

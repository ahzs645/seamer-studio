import { describe, expect, it } from 'vitest';
import { libraryPanelMaxHeight, libraryPanelViewport } from './libraryViewport';

describe('actual Library popup viewport budget', () => {
  it('uses the measured one-row landscape popup instead of the previous two-row allowance', () => {
    expect(libraryPanelMaxHeight(56, 375)).toBe(311);
    expect(libraryPanelMaxHeight(56, 375)).toBe(375 - 112 + 48);
  });
  it.each([[104, 844, 0, 732], [104, 280, 0, 168], [76, 720, 0, 636],
    [180, 280, 100, 192], [56, 200, 0, 136], [400, 375, 0, 0]])('bounds popup at%s against visible height%s offset%s', (top, height, offset, expected) => {
      expect(libraryPanelMaxHeight(top, height, offset)).toBe(expected);
    });
  it('keeps the normal landscape top and yields48 more pixels of results', () => {
    expect(libraryPanelViewport(56, 375)).toEqual({ top: 56, maxHeight: 311 });
  });
  it('moves a panned keyboard viewport Close row into the visible screen', () => {
    expect(libraryPanelViewport(104, 280, 150)).toEqual({ top: 158, maxHeight: 264 });
  });
  it('repositions a popup with insufficient space for its44px Close row', () => {
    expect(libraryPanelViewport(104, 150)).toEqual({ top: 8, maxHeight: 134 });
  });
  it('fails closed for an invalid visual viewport', () => {
    expect(libraryPanelViewport(56, NaN)).toBeNull();
  });
  it.each([[NaN, 375, 0], [56, Infinity, 0], [56, 0, 0], [56, 375, NaN]])('refuses invalid measured bounds', (top, height, offset) => {
      expect(libraryPanelMaxHeight(top, height, offset)).toBeNull();
    });
});

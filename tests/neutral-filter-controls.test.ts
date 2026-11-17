import { createElement, isValidElement, type EffectCallback, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeriodFilter, RangeFilter, ReelFilters, filterScope } from '../src/components/reel-filters';
import { defaultReelFilters } from '../src/lib/reel-filters';
import type { ReelQuery } from '../src/lib/types';

// Exercise control event handlers and debounce effects without a browser or DOM dependency.
const hooks = vi.hoisted(() => ({ active: null as null | { states: unknown[]; cursor: number; effects: EffectCallback[] } }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return {
    ...react,
    useId: () => hooks.active ? 'control-test' : react.useId(),
    useState: (initial: unknown) => {
      const active = hooks.active;
      if (!active) return react.useState(initial);
      const index = active.cursor++;
      if (!(index in active.states)) active.states[index] = typeof initial === 'function' ? initial() : initial;
      return [active.states[index], (next: unknown) => { active.states[index] = typeof next === 'function' ? next(active.states[index]) : next; }];
    },
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => hooks.active ? factory() : react.useMemo(factory, deps),
    useEffect: (effect: EffectCallback, deps: readonly unknown[]) => {
      if (hooks.active) hooks.active.effects.push(effect);
      else react.useEffect(effect, deps);
    },
  };
});

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); hooks.active = null; vi.useRealTimers(); });

function controlHarness(renderControl: () => ReactNode) {
  const state = { states: [] as unknown[], cursor: 0, effects: [] as EffectCallback[] };
  let effects: (() => void)[] = [];
  cleanups.push(() => effects.forEach(cleanup => cleanup()));
  return {
    render() {
      effects.forEach(cleanup => cleanup());
      state.cursor = 0; state.effects = []; hooks.active = state;
      let tree: ReactNode;
      try { tree = renderControl(); } finally { hooks.active = null; }
      effects = state.effects.map(effect => effect()).filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
      return tree;
    },
  };
}

type Control = {
  value: string; max: number; 'aria-invalid'?: boolean;
  onChange: (event: { target: { value: string; validity: { badInput: boolean } } }) => void;
  onBlur: () => void;
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void;
};
function control(tree: ReactNode, label: string): Control {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      try { return control(child, label); } catch { /* Search siblings. */ }
    }
  } else if (isValidElement<{ 'aria-label'?: string; children?: ReactNode }>(tree)) {
    if (tree.props['aria-label'] === label) return tree.props as unknown as Control;
    if (tree.props.children) return control(tree.props.children, label);
  }
  throw new Error(`Missing control: ${label}`);
}
function change(input: Control, value: string, badInput = false) { input.onChange({ target: { value, validity: { badInput } } }); }

function rangeHarness(low?: number, high?: number, integer = false) {
  const onChange = vi.fn();
  const harness = controlHarness(() => RangeFilter({ label: 'Metric', minimum: 0, maximum: 100, low, high, integer, onChange }));
  return { ...harness, onChange };
}
function periodHarness(value: ReelQuery = {}) {
  const onChange = vi.fn();
  const harness = controlHarness(() => PeriodFilter({ value, onChange }));
  return { ...harness, onChange };
}

describe('neutral filter presentation', () => {
  it('renders neutral metric and all-time period fields blank, with no invalid or fabricated values', () => {
    const html = renderToStaticMarkup(createElement(ReelFilters, { workspaceId: 'workspace', value: defaultReelFilters(), onChange: () => {}, notify: () => {} }));
    for (const label of ['Minimum Outlier Score', 'Maximum Outlier Score', 'Minimum Views', 'Maximum Views', 'Minimum Engagement', 'Maximum Engagement', 'Posted in last amount']) {
      const input = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0];
      expect(input).toBeDefined();
      expect(input).toContain('value=""');
      expect(input).not.toContain('aria-invalid="true"');
    }
    expect(html).toContain('placeholder="e.g. 7"');
    expect(html).toContain('value="" selected="">Select unit');
    expect(html).not.toContain('value="undefined"');
    expect(html).not.toContain('value="9"');
  });
  it('preserves explicit zero ranges and nine-month rolling periods in presentation', () => {
    const range = renderToStaticMarkup(createElement(RangeFilter, { label: 'Metric', minimum: 0, maximum: 100, low: 0, high: 0, onChange: () => {} }));
    expect(range.match(/value="0"/g)).toHaveLength(2);
    expect(range).not.toContain('aria-invalid="true"');
    const period = renderToStaticMarkup(createElement(PeriodFilter, { value: { posted_amount: 9, posted_unit: 'months' }, onChange: () => {} }));
    expect(period).toContain('value="9"');
    expect(period).toContain('value="months" selected');
    expect(period).toContain('max="12"');
  });
  it('does not restore hidden numeric defaults for an outlier view, while retaining saved and creator scopes', () => {
    expect(filterScope({})).toEqual({});
    expect(filterScope({ min_outlier: 0 })).toEqual({ min_outlier: 0 });
    expect(filterScope({ saved: false, min_outlier: 1, creator_id: 'other' }, { savedOnly: true, creatorId: 'locked' })).toEqual({ saved: true, min_outlier: 1, creator_id: 'locked' });
  });
});

describe('optional range control drafts', () => {
  it('does not commit neutral blanks on mount, blur, Enter, or debounce', () => {
    vi.useFakeTimers();
    const harness = rangeHarness();
    const input = control(harness.render(), 'Minimum Metric');
    expect(input.value).toBe(''); expect(input['aria-invalid']).toBe(false);
    input.onBlur(); input.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
    vi.advanceTimersByTime(500);
    expect(harness.onChange).not.toHaveBeenCalled();
  });
  it.each(['Minimum Metric', 'Maximum Metric'])('commits explicit zero for %s without adding the other bound', label => {
    const harness = rangeHarness();
    change(control(harness.render(), label), '0');
    const input = control(harness.render(), label);
    expect(input.value).toBe('0'); expect(input['aria-invalid']).toBe(false);
    input.onBlur();
    expect(harness.onChange).toHaveBeenCalledWith(...(label === 'Minimum Metric' ? [0, undefined] : [undefined, 0]));
  });
  it.each(['Minimum Metric', 'Maximum Metric'])('clears only %s to undefined, including zero', label => {
    const harness = rangeHarness(0, 0);
    change(control(harness.render(), label), '');
    control(harness.render(), label).onBlur();
    expect(harness.onChange).toHaveBeenCalledWith(...(label === 'Minimum Metric' ? [undefined, 0] : [0, undefined]));
  });
  it('clears both bounds to undefined and debounces without applying baseline values', () => {
    vi.useFakeTimers();
    const harness = rangeHarness(1, 50);
    change(control(harness.render(), 'Minimum Metric'), '');
    change(control(harness.render(), 'Maximum Metric'), '');
    const input = control(harness.render(), 'Minimum Metric');
    expect(input['aria-invalid']).toBe(false);
    vi.advanceTimersByTime(349); expect(harness.onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(harness.onChange).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
  });
  it.each(['-1', '101', 'NaN', 'Infinity', '1e2', ' ', '0x10', '1.5'])('rejects invalid integer/finite/bounded drafts %s without committing', text => {
    vi.useFakeTimers();
    for (const label of ['Minimum Metric', 'Maximum Metric']) {
      const harness = rangeHarness(undefined, undefined, true);
      change(control(harness.render(), label), text);
      const input = control(harness.render(), label);
      expect(input['aria-invalid']).toBe(true);
      input.onBlur(); input.onKeyDown({ key: 'Enter', preventDefault: vi.fn() });
      vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
    }
  });
  it('allows fractional metric bounds, rejects reversed pairs and cancels pending valid drafts', () => {
    vi.useFakeTimers();
    const harness = rangeHarness(undefined, 10);
    change(control(harness.render(), 'Minimum Metric'), '1.5');
    expect(control(harness.render(), 'Minimum Metric')['aria-invalid']).toBe(false);
    vi.advanceTimersByTime(100);
    change(control(harness.render(), 'Minimum Metric'), '11');
    const input = control(harness.render(), 'Minimum Metric');
    expect(input['aria-invalid']).toBe(true); input.onBlur();
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
  });
  it('does not mistake browser-sanitized invalid number input for a cleared bound', () => {
    vi.useFakeTimers();
    const harness = rangeHarness(1, 10);
    change(control(harness.render(), 'Minimum Metric'), '', true);
    const input = control(harness.render(), 'Minimum Metric');
    expect(input['aria-invalid']).toBe(true); input.onBlur();
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
  });
});

describe('optional period control drafts', () => {
  it('keeps a neutral period all-time on blur and unit selection, using the chosen unit only when amount is entered', () => {
    vi.useFakeTimers();
    const harness = periodHarness();
    const tree = harness.render();
    control(tree, 'Posted in last amount').onBlur();
    change(control(tree, 'Posted in last unit'), 'months');
    const next = harness.render();
    expect(control(next, 'Posted in last amount').value).toBe('');
    expect(control(next, 'Posted in last unit').value).toBe('months');
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
    change(control(next, 'Posted in last amount'), '9'); harness.render();
    vi.advanceTimersByTime(349); expect(harness.onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.onChange).toHaveBeenCalledExactlyOnceWith({ posted_amount: 9, posted_unit: 'months', from: undefined, to: undefined });
  });
  it('clears an explicit period without introducing dates, zero, or a replacement amount', () => {
    vi.useFakeTimers();
    const harness = periodHarness({ posted_amount: 9, posted_unit: 'months' });
    change(control(harness.render(), 'Posted in last amount'), ''); harness.render();
    vi.advanceTimersByTime(350);
    expect(harness.onChange).toHaveBeenCalledExactlyOnceWith({ posted_amount: undefined, posted_unit: undefined });
  });
  it('preserves custom dates until a user explicitly sets a valid rolling amount', () => {
    vi.useFakeTimers();
    const harness = periodHarness({ from: '2026-11-01', to: '2026-11-08' });
    control(harness.render(), 'Posted in last amount').onBlur();
    change(control(harness.render(), 'Posted in last unit'), 'weeks'); harness.render();
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
    change(control(harness.render(), 'Posted in last amount'), '1');
    control(harness.render(), 'Posted in last amount').onBlur();
    expect(harness.onChange).toHaveBeenCalledWith({ posted_amount: 1, posted_unit: 'weeks', from: undefined, to: undefined });
  });
  it.each(['0', '-1', '1.5', '367', 'NaN', 'Infinity', '1e2', ' ', '9007199254740992'])('rejects invalid positive whole-period draft %s', text => {
    vi.useFakeTimers();
    const harness = periodHarness();
    change(control(harness.render(), 'Posted in last amount'), text);
    control(harness.render(), 'Posted in last amount').onBlur();
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
  });
  it.each([['days', '366'], ['weeks', '52'], ['months', '12']] as const)('retains %s unit-specific bounds', (unit, maximum) => {
    vi.useFakeTimers();
    const harness = periodHarness();
    change(control(harness.render(), 'Posted in last unit'), unit);
    expect(control(harness.render(), 'Posted in last amount').max).toBe(Number(maximum));
    change(control(harness.render(), 'Posted in last amount'), String(Number(maximum) + 1));
    control(harness.render(), 'Posted in last amount').onBlur();
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
    change(control(harness.render(), 'Posted in last amount'), maximum); harness.render();
    vi.advanceTimersByTime(350);
    expect(harness.onChange).toHaveBeenCalledExactlyOnceWith({ posted_amount: Number(maximum), posted_unit: unit, from: undefined, to: undefined });
  });
  it('does not clear an explicit period for browser-sanitized invalid input', () => {
    vi.useFakeTimers();
    const harness = periodHarness({ posted_amount: 9, posted_unit: 'months' });
    change(control(harness.render(), 'Posted in last amount'), '', true);
    control(harness.render(), 'Posted in last amount').onBlur();
    vi.advanceTimersByTime(500); expect(harness.onChange).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

// Parse declarations instead of snapshotting CSS formatting. These are source-level
// regression checks; OS-owned select/calendar popups still need browser review.
const globals = postcss.parse(readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8'));
const theme = postcss.parse(readFileSync(join(process.cwd(), 'src/app/research-theme.css'), 'utf8'));
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const findRule = (fragment: string, root: postcss.Container = theme): Rule => {
  let found: Rule | undefined;
  root.walkRules(rule => {
    if (!found && normalize(rule.selector).includes(normalize(fragment))) found = rule;
  });
  if (!found) throw new Error(`Missing control rule: ${fragment}`);
  return found;
};
const declarations = (rule: Rule) => Object.fromEntries(
  rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]),
);
const tokens = declarations(findRule(':root'));
const resolve = (value: string): string => {
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  return variable ? resolve(tokens[variable[1]]) : value;
};
const luminance = (value: string) => {
  const hex = resolve(value).replace('#', '');
  if (!/^[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque color, got ${value}`);
  const channels = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
};
const contrast = (foreground: string, background: string) => {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
const controls = () => findRule('.login-form-wrap .field input');
const search = () => findRule('body :is(.search-field, .field .search-field)');
const searchInput = () => findRule('body :is(.search-field input, .field.keyword-filter .search-field input)');

describe('dark native control styling', () => {
  it('covers standalone numeric/text controls as well as the more specific legacy field cascade', () => {
    const base = controls();
    for (const selector of ['input:where(', 'textarea', 'select', '.field input', '.field textarea', '.field select', '.range-filter input', '.sort-field select']) {
      expect(base.selector).toContain(selector);
    }
    expect(base.selector.trim().startsWith('body ')).toBe(true);
    expect(declarations(base)).toMatchObject({
      'color-scheme': 'dark', 'background-color': 'var(--control-surface)',
      border: '1px solid var(--control-border)', 'border-radius': 'var(--control-radius)',
      color: 'var(--control-text)', padding: '.5rem .75rem',
      'min-height': 'var(--control-size)', 'font-size': 'var(--text-body)',
    });
    const sizes = declarations(findRule(':root', globals));
    expect(sizes).toMatchObject({ '--control-size': '2.75rem', '--text-body': '1rem', '--text-ui': '.875rem', '--text-meta': '.75rem' });
  });

  it('keeps input text and placeholders readable across normal, hover, disabled and invalid surfaces', () => {
    const base = controls();
    const foreground = declarations(base).color;
    const placeholder = declarations(findRule('&::placeholder', base));
    expect(placeholder.opacity).toBe('1');
    for (const surface of ['--control-surface', '--control-hover', '--control-disabled-surface', '--control-invalid-surface']) {
      expect(contrast(foreground, tokens[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(placeholder.color, tokens[surface])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens['--control-invalid'], tokens['--control-invalid-surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#b1c2df', tokens['--paper'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#e0edff', '#203955')).toBeGreaterThanOrEqual(4.5);
  });

  it('provides visible control boundaries and keyboard focus without important overrides', () => {
    for (const surface of ['--control-surface', '--paper', '--control-hover', '--control-disabled-surface']) {
      expect(contrast(tokens['--control-border'], tokens[surface])).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens['--control-focus'], tokens[surface])).toBeGreaterThanOrEqual(3);
    }
    expect(declarations(findRule('&:focus-visible', controls()))).toMatchObject({
      outline: '2px solid var(--control-focus)', 'outline-offset': '3px',
    });
    expect(declarations(findRule('&:focus', controls()))['border-color']).toBe('var(--control-focus)');
    theme.walkDecls(declaration => {
      if (declaration.prop !== 'color') expect(declaration.important).toBeFalsy();
    });
    globals.walkRules(rule => {
      if (/input:focus|textarea:focus|select:focus/.test(rule.selector)) {
        rule.walkDecls(declaration => expect(declaration.important).toBeFalsy());
      }
    });
  });

  it('keeps invalid feedback during hover/focus and disabled controls readable without opacity washout', () => {
    const base = controls();
    const hover = findRule('&:hover', base);
    expect(hover.selector).toContain(':disabled');
    expect(hover.selector).toContain('[aria-invalid="true"]');
    expect(declarations(findRule('&[aria-invalid="true"]', base))).toMatchObject({
      'background-color': 'var(--control-invalid-surface)', 'border-color': 'var(--control-invalid)',
    });
    expect(declarations(findRule('&[aria-invalid="true"]:focus-visible', base))['outline-color']).toBe('var(--control-invalid)');
    expect(declarations(findRule('&:disabled', base))).toMatchObject({
      'background-color': 'var(--control-disabled-surface)', color: 'var(--control-placeholder)',
      cursor: 'not-allowed', opacity: '1',
    });
  });

  it('puts one border and the keyboard focus/error indicators on the search wrapper, not a nested field input', () => {
    const wrapper = search();
    expect(declarations(wrapper).border).toBe('1px solid var(--control-border)');
    expect(declarations(findRule('&:has(input:focus-visible)', wrapper))).toMatchObject({
      outline: '2px solid var(--control-focus)', 'outline-offset': '3px',
    });
    expect(declarations(findRule('&:focus-within', wrapper))['border-color']).toBe('var(--control-focus)');
    expect(declarations(findRule('&:has(input[aria-invalid="true"])', wrapper))['border-color']).toBe('var(--control-invalid)');
    expect(declarations(findRule('&:has(input:disabled)', wrapper))['background-color']).toBe('var(--control-disabled-surface)');
    expect(declarations(searchInput())).toMatchObject({ background: 'transparent', border: '0', padding: '.5rem 0', 'box-shadow': 'none' });
    expect(declarations(findRule('&:hover', searchInput()))).toMatchObject({ background: 'transparent', border: '0', outline: 'none', 'box-shadow': 'none' });
    expect(declarations(findRule('&:hover', wrapper))['border-color']).toBe('var(--control-border-hover)');
  });

  it('spaces select chevrons, supports option/optgroup colors and gives sorting deliberate dark chrome', () => {
    const select = declarations(findRule('&:is(select)', controls()));
    expect(select.appearance).toBe('none');
    expect(select['background-image']).toMatch(/^url\(/);
    expect(select['padding-right']).toBe('2.5rem');
    expect(select['background-repeat']).toBe('no-repeat');
    expect(declarations(findRule('body select :is(option, optgroup)'))).toMatchObject({
      'background-color': 'var(--control-surface)', color: 'var(--control-text)',
    });
    expect(declarations(findRule('body select optgroup'))['font-weight']).toBe('600');
    expect(declarations(findRule('&:where(.sort-field select)', controls()))['background-color']).toBe('var(--control-hover)');
    expect(declarations(findRule('body .field .period-inputs select:has(option:checked[value=""])')).color).toBe('var(--control-placeholder)');
  });

  it('avoids duplicate workspace chevrons and preserves a focus indicator on their wrappers', () => {
    expect(declarations(findRule('&:is(.sidebar-workspace-select select, .top-workspace select)', controls()))).toMatchObject({
      'background-image': 'none', border: '0', padding: '.5rem 0',
    });
    const workspace = findRule('body :is(.sidebar-workspace-select, .top-workspace)');
    expect(declarations(findRule('&:has(select:focus-visible)', workspace)).outline).toBe('2px solid var(--control-focus)');
  });

  it('retains the real date/time picker and search clear indicators', () => {
    const dates = findRule('body input:where([type=date]');
    for (const type of ['date', 'datetime-local', 'time', 'month', 'week']) expect(dates.selector).toContain(`[type=${type}]`);
    const indicator = declarations(findRule('&::-webkit-calendar-picker-indicator', dates));
    expect(indicator).toMatchObject({ opacity: '1', cursor: 'pointer' });
    expect(indicator.display).not.toBe('none');
    expect(indicator.filter).toBeUndefined();
    for (const root of [globals, theme]) {
      root.walkRules(rule => {
        if (/calendar-picker-indicator|search-cancel-button/.test(rule.selector)) {
          const values = declarations(rule);
          expect(values.display).not.toBe('none');
          expect(values.appearance).not.toBe('none');
          expect(values.opacity).not.toBe('0');
        }
      });
    }
  });

  it('keeps channel chips responsive with unclipped focus and a full-sized More filters target', () => {
    const channels = declarations(findRule('.channel-options', globals));
    expect(channels).toMatchObject({ display: 'flex', 'flex-wrap': 'wrap', 'min-width': '0', 'overflow-y': 'auto' });
    expect(parseFloat(channels.padding)).toBeGreaterThanOrEqual(5);
    expect(declarations(findRule('.advanced-filter-more summary', globals))['min-height']).toBe('var(--control-size)');
    expect(declarations(findRule('.advanced-filter-more summary:focus-visible', globals)).outline).toBe('2px solid var(--ochre)');
    expect(declarations(findRule('&[aria-pressed="true"]', findRule('.channel-option')))['border-color']).toBe('var(--control-focus)');
  });
});

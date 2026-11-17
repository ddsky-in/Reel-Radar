'use client';

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { calendarDate, calendarDateAllowed, calendarDays, shiftCalendarDate, shiftCalendarMonth, todayInIndia } from '@/lib/calendar';
import { closeControlPopover, ControlPopover, openControlPopover } from './control-popover';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max'> & {
  value: string; onChange: (value: string) => void; min?: string; max?: string; 'aria-label': string;
};
const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const valueFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function DatePicker({ value, onChange, min, max, disabled, 'aria-label': label, ...props }: Props) {
  const id = useId(), anchorId = `${id}-date-trigger`, panelId = `${id}-calendar`;
  const wrapper = useRef<HTMLSpanElement>(null), focusDay = useRef(false);
  const [open, setOpen] = useState(false);
  const initial = calendarDate(value) ? value : min || todayInIndia();
  const [active, setActive] = useState(initial), [month, setMonth] = useState(initial.slice(0, 7));
  const days = calendarDays(month), today = todayInIndia();
  function panel() { return wrapper.current!.querySelector<HTMLElement>('[popover]')!; }
  function show() {
    if (disabled) return;
    const next = calendarDate(value) ? value : [today, min].filter(Boolean).sort().at(-1)!;
    const bounded = max && next > max ? max : next;
    focusDay.current = true; setActive(bounded); setMonth(bounded.slice(0, 7));
    openControlPopover(panel(), document.getElementById(anchorId)!);
  }
  function choose(next: string) {
    if (next && !calendarDateAllowed(next, min, max)) return;
    onChange(next);
    closeControlPopover(panel(), wrapper.current!.querySelector('input')!);
  }
  useEffect(() => {
    if (!open || !focusDay.current) return;
    wrapper.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus();
    focusDay.current = false;
  }, [open, active, month]);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    let next: string | undefined;
    const weekday = (calendarDate(date)!.getUTCDay() + 6) % 7;
    if (event.key === 'ArrowLeft') next = shiftCalendarDate(date, -1);
    if (event.key === 'ArrowRight') next = shiftCalendarDate(date, 1);
    if (event.key === 'ArrowUp') next = shiftCalendarDate(date, -7);
    if (event.key === 'ArrowDown') next = shiftCalendarDate(date, 7);
    if (event.key === 'Home') next = shiftCalendarDate(date, -weekday);
    if (event.key === 'End') next = shiftCalendarDate(date, 6 - weekday);
    if (event.key === 'PageUp') next = shiftCalendarMonth(date, event.shiftKey ? -12 : -1);
    if (event.key === 'PageDown') next = shiftCalendarMonth(date, event.shiftKey ? 12 : 1);
    if (!next) return;
    event.preventDefault();
    if (!calendarDateAllowed(next, min, max)) return;
    focusDay.current = true; setActive(next); setMonth(next.slice(0, 7));
  }
  function moveMonth(amount: number) {
    const next = shiftCalendarMonth(`${month}-01`, amount);
    const last = shiftCalendarDate(shiftCalendarMonth(next, 1), -1);
    if ((min && last < min) || (max && next > max)) return;
    setMonth(next.slice(0, 7));
    setActive(min && next < min ? min : next);
  }
  const previousLast = shiftCalendarDate(`${month}-01`, -1);
  const nextFirst = shiftCalendarMonth(`${month}-01`, 1);
  return <span className="control-date" ref={wrapper}>
    <input {...props} name={undefined} type="text" role="combobox" aria-label={label} aria-haspopup="dialog" aria-controls={panelId} aria-expanded={open} readOnly autoComplete="off" inputMode="none" placeholder={props.placeholder ?? 'Select date'} value={calendarDate(value) ? valueFormat.format(calendarDate(value)!) : ''} disabled={disabled} onClick={event => {
      props.onClick?.(event);
      if (!event.defaultPrevented) { event.preventDefault(); show(); }
    }} onKeyDown={event => {
      props.onKeyDown?.(event);
      if (['ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(); }
    }}/>
    {props.name && <input type="hidden" name={props.name} value={value}/>}
    <button type="button" id={anchorId} className="control-date-trigger" aria-label={`Open ${label.toLowerCase()} calendar`} aria-haspopup="dialog" aria-controls={panelId} aria-expanded={open} disabled={disabled} onClick={() => open ? closeControlPopover(panel()) : show()}><CalendarDays size={16} aria-hidden="true"/></button>
    <ControlPopover id={panelId} anchorId={anchorId} className="control-calendar" role="dialog" aria-label={`${label} calendar`} onOpenChange={setOpen}>
      <div className="calendar-heading"><button type="button" className="calendar-nav" aria-label="Previous month" disabled={Boolean(min && previousLast < min)} onClick={() => moveMonth(-1)}><ChevronLeft size={16} aria-hidden="true"/></button><strong aria-live="polite">{monthFormat.format(calendarDate(`${month}-01`)!)}</strong><button type="button" className="calendar-nav" aria-label="Next month" disabled={Boolean(max && nextFirst > max)} onClick={() => moveMonth(1)}><ChevronRight size={16} aria-hidden="true"/></button></div>
      <div role="grid" aria-label={monthFormat.format(calendarDate(`${month}-01`)!)} className="calendar-grid">
        <div role="row" className="calendar-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
        {Array.from({ length: 6 }, (_, row) => <div role="row" className="calendar-week" key={row}>{days.slice(row * 7, row * 7 + 7).map(date => <button type="button" role="gridcell" key={date} data-date={date} data-outside={date.slice(0, 7) !== month} data-today={date === today} aria-label={dayFormat.format(calendarDate(date)!)} aria-selected={date === value} aria-current={date === today ? 'date' : undefined} disabled={!calendarDateAllowed(date, min, max)} tabIndex={date === active ? 0 : -1} onFocus={() => setActive(date)} onKeyDown={event => navigate(event, date)} onClick={() => choose(date)}>{Number(date.slice(-2))}</button>)}</div>)}
      </div>
      <div className="calendar-footer"><button type="button" disabled={!value} onClick={() => choose('')}>Clear</button><span>IST</span><button type="button" disabled={!calendarDateAllowed(today, min, max)} onClick={() => choose(today)}>Today</button></div>
    </ControlPopover>
  </span>;
}

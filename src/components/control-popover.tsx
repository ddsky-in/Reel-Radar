'use client';

import { useEffect, useRef, type HTMLAttributes } from 'react';

function positionPopover(panel: HTMLElement, anchor: HTMLElement) {
  const bounds = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const leftEdge = viewport?.offsetLeft ?? 0;
  const topEdge = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const gap = 6, margin = 8;
  panel.style.maxWidth = `${width - margin * 2}px`;
  if (panel.dataset.matchWidth === 'true') panel.style.width = `${bounds.width}px`;
  const below = topEdge + height - bounds.bottom - gap - margin;
  const above = bounds.top - topEdge - gap - margin;
  panel.style.maxHeight = `${Math.max(0, Math.max(below, above))}px`;
  const size = panel.getBoundingClientRect();
  const up = size.height > below && above > below;
  panel.style.left = `${Math.max(leftEdge + margin, Math.min(bounds.left, leftEdge + width - size.width - margin))}px`;
  panel.style.top = `${Math.max(topEdge + margin, up ? bounds.top - size.height - gap : bounds.bottom + gap)}px`;
}

export function openControlPopover(panel: HTMLElement, anchor: HTMLElement) {
  if (!panel.matches(':popover-open')) panel.showPopover();
  positionPopover(panel, anchor);
}

export function closeControlPopover(panel: HTMLElement, anchor?: HTMLElement) {
  if (panel.matches(':popover-open')) panel.hidePopover();
  anchor?.focus();
}

/** The browser top layer avoids clipping inside scrollable sidebars and dialogs. */
export function ControlPopover({ anchorId, matchWidth = false, onOpenChange, className = '', children, ...props }: HTMLAttributes<HTMLDivElement> & { anchorId: string; matchWidth?: boolean; onOpenChange?: (open: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = ref.current;
    function reposition(event?: Event) {
      const anchor = document.getElementById(anchorId);
      if (!panel || !anchor || !panel.matches(':popover-open')) return;
      if (event?.target instanceof Node && panel.contains(event.target)) return;
      if (anchor.getBoundingClientRect().bottom <= 0) { panel.hidePopover(); return; }
      positionPopover(panel, anchor);
    }
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [anchorId]);
  return <div {...props} ref={ref} popover="auto" className={`control-popover ${className}`} data-match-width={matchWidth} onToggle={event => {
    const open = event.newState === 'open';
    onOpenChange?.(open);
    const details = event.currentTarget.closest('details');
    if (!open && details?.classList.contains('channel-picker')) details.open = false;
  }} onKeyDown={event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      closeControlPopover(event.currentTarget, document.getElementById(anchorId) ?? undefined);
    }
  }}>{children}</div>;
}

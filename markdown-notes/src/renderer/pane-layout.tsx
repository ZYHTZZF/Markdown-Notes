import React, { useCallback, useEffect, useRef, useState } from 'react';

type Pane = 'sidebar' | 'list';
type Widths = Record<Pane, number>;
type Preferred = Partial<Widths> & { hidden?: Partial<Record<Pane, boolean>> };
type Drag = {
  pane: Pane;
  pointer: number;
  x: number;
  widths: Widths;
  start: Preferred;
  capture: HTMLElement;
  collapse: boolean;
};
const STORAGE_KEY = 'zhiye.pane-widths.v1';
const MIN: Widths = { sidebar: 176, list: 220 };
const MAX: Widths = { sidebar: 320, list: 480 };
const COLLAPSE_DISTANCE = 48;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
const defaults = (width: number): Widths =>
  width <= 1250 ? { sidebar: 176, list: 232 } : { sidebar: 200, list: 260 };
function budget(width: number, hidden: Preferred['hidden']) {
  const inset = width <= 1250 ? 8 : 12;
  return width - inset - (hidden?.sidebar ? inset : 0) - 2 - (hidden?.list ? 0 : 6) - 560;
}
function fit(preferred: Preferred, width: number): Widths {
  const initial = defaults(width),
    space = budget(width, preferred.hidden);
  const sidebar = preferred.hidden?.sidebar
    ? 0
    : clamp(
        preferred.sidebar ?? initial.sidebar,
        MIN.sidebar,
        Math.min(MAX.sidebar, space - (preferred.hidden?.list ? 0 : MIN.list)),
      );
  const list = preferred.hidden?.list
    ? 0
    : clamp(preferred.list ?? initial.list, MIN.list, Math.min(MAX.list, space - sidebar));
  return { sidebar, list };
}
function load(): Preferred {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Preferred = { hidden: {} };
    for (const pane of ['sidebar', 'list'] as const) {
      if (typeof value[pane] === 'number' && Number.isFinite(value[pane]))
        result[pane] = clamp(value[pane], MIN[pane], MAX[pane]);
      if (typeof value.hidden?.[pane] === 'boolean') result.hidden![pane] = value.hidden[pane];
    }
    return result;
  } catch {
    return {};
  }
}
function persist(value: Preferred) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Layout still works without local storage. */
  }
}

export function usePaneLayout() {
  const [preferred, setPreferred] = useState<Preferred>(load);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const [collapsePending, setCollapsePending] = useState<Pane | null>(null);
  const latest = useRef(preferred),
    drag = useRef<Drag | null>(null);
  const widths = fit(preferred, viewport);
  const hidden = { sidebar: !!preferred.hidden?.sidebar, list: !!preferred.hidden?.list };
  const apply = useCallback((next: Preferred, save = false) => {
    latest.current = next;
    setPreferred(next);
    if (save) persist(next);
  }, []);
  const finish = useCallback(
    (acceptCollapse = false) => {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      if (acceptCollapse && current.collapse) {
        apply(
          {
            ...current.start,
            [current.pane]: current.widths[current.pane],
            hidden: { ...current.start.hidden, [current.pane]: true },
          },
          true,
        );
      } else persist(latest.current);
      setResizing(false);
      setCollapsePending(null);
      if (current.capture.hasPointerCapture(current.pointer))
        current.capture.releasePointerCapture(current.pointer);
    },
    [apply],
  );
  const move = useCallback(
    (x: number) => {
      const current = drag.current;
      if (!current) return;
      const pane = current.pane,
        other = pane === 'sidebar' ? 'list' : 'sidebar';
      const wanted = current.widths[pane] + x - current.x;
      const max = Math.max(
        MIN[pane],
        Math.min(
          MAX[pane],
          budget(window.innerWidth, current.start.hidden) - current.widths[other],
        ),
      );
      current.collapse = wanted <= MIN[pane] - COLLAPSE_DISTANCE;
      setCollapsePending(current.collapse ? pane : null);
      apply({
        ...current.start,
        [pane]: Math.round(clamp(wanted, MIN[pane], max)),
        ...(!current.start.hidden?.[other] ? { [other]: current.widths[other] } : {}),
      });
    },
    [apply],
  );
  useEffect(() => {
    const end = () => finish(false);
    const resize = () => {
      end();
      setViewport(window.innerWidth);
    };
    const pointerMove = (e: PointerEvent) => {
      if (drag.current?.pointer !== e.pointerId) return;
      if (e.buttons === 0) {
        end();
        return;
      }
      move(e.clientX);
    };
    const release = (e: MouseEvent) => {
      if (!drag.current || ('pointerId' in e && drag.current.pointer !== e.pointerId)) return;
      move(e.clientX);
      finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (drag.current?.pointer === e.pointerId) end();
    };
    const lost = (e: PointerEvent) => {
      if (e.target === drag.current?.capture && drag.current?.pointer === e.pointerId) end();
    };
    window.addEventListener('resize', resize);
    window.addEventListener('blur', end);
    window.addEventListener('pointermove', pointerMove, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('mouseup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('lostpointercapture', lost, true);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', end);
      window.removeEventListener('pointermove', pointerMove, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('mouseup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('lostpointercapture', lost, true);
    };
  }, [finish, move]);
  const toggle = (pane: Pane) => {
    finish(false);
    const next = {
      ...latest.current,
      hidden: { ...latest.current.hidden, [pane]: !latest.current.hidden?.[pane] },
    };
    if (next.hidden[pane]) next[pane] = widths[pane];
    apply(next, true);
  };
  const divider = (pane: Pane) => {
    const other = pane === 'sidebar' ? 'list' : 'sidebar';
    const maximum = Math.max(
      MIN[pane],
      Math.min(MAX[pane], budget(viewport, preferred.hidden) - widths[other]),
    );
    const reset = () => {
      finish(false);
      const next = { ...latest.current };
      delete next[pane];
      apply(next, true);
    };
    return {
      pane,
      value: widths[pane],
      minimum: MIN[pane],
      maximum,
      collapsePending: collapsePending === pane,
      onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
        if (e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        e.currentTarget.focus();
        const capture = e.currentTarget;
        capture.setPointerCapture(e.pointerId);
        drag.current = {
          pane,
          pointer: e.pointerId,
          x: e.clientX,
          widths,
          capture,
          start: latest.current,
          collapse: false,
        };
        setResizing(true);
      },
      onDoubleClick: reset,
      onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
        const step = e.shiftKey ? 50 : 10;
        let next: number;
        if (e.key === 'ArrowLeft') next = widths[pane] - step;
        else if (e.key === 'ArrowRight') next = widths[pane] + step;
        else if (e.key === 'Home') next = MIN[pane];
        else if (e.key === 'End') next = maximum;
        else if (e.key === 'Enter') {
          e.preventDefault();
          reset();
          return;
        } else return;
        e.preventDefault();
        apply(
          {
            ...latest.current,
            [pane]: clamp(next, MIN[pane], maximum),
            ...(!hidden[other] ? { [other]: widths[other] } : {}),
          },
          true,
        );
      },
    };
  };
  return { widths, hidden, resizing, divider, toggle };
}

export function PaneDivider({
  pane,
  value,
  minimum,
  maximum,
  collapsePending,
  ...events
}: ReturnType<ReturnType<typeof usePaneLayout>['divider']>) {
  const name = pane === 'sidebar' ? '导航栏' : '笔记列表';
  return (
    <div
      {...events}
      className={`pane-divider ${pane}-divider`}
      role="separator"
      tabIndex={0}
      aria-label={`调整${name}宽度`}
      aria-orientation="vertical"
      aria-controls={pane === 'sidebar' ? 'navigation-pane' : 'note-list-pane'}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value}
      aria-valuetext={`${value} 像素`}
      data-collapse-pending={collapsePending}
      data-hide-label={`松开隐藏${name}`}
      title={`拖动调整宽度，继续向左拖可隐藏${name}；双击或回车恢复默认；方向键微调`}
    >
      <span />
    </div>
  );
}

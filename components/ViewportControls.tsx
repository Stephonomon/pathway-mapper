'use client';

/**
 * Subtle map-style controls floating over the document: a pan pad, a zoom
 * column, and the two framing shortcuts (whole page / whole route).
 *
 * Deliberately low-contrast until hovered — the document is the thing being
 * read, and chrome that competes with it is chrome in the way.
 */

interface ViewportControlsProps {
  onPan: (dx: number, dy: number) => void;
  onZoom: (factor: number) => void;
  onFitPage: () => void;
  onFitRoute: () => void;
  hasRoute: boolean;
  zoom: number;
}

const BUTTON =
  'flex h-7 w-7 items-center justify-center rounded text-slate-600 transition hover:bg-slate-900/10 hover:text-slate-900 active:scale-95 disabled:opacity-25 disabled:hover:bg-transparent';

function Icon({ d, label }: { d: string; label: string }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-label={label} role="img">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const CHEVRON_UP = 'M4 10l4-4 4 4';
const CHEVRON_DOWN = 'M4 6l4 4 4-4';
const CHEVRON_LEFT = 'M10 4l-4 4 4 4';
const CHEVRON_RIGHT = 'M6 4l4 4-4 4';
const PLUS = 'M8 3.5v9M3.5 8h9';
const MINUS = 'M3.5 8h9';
const FIT_PAGE = 'M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3';
const FIT_ROUTE = 'M3 12.5h3a2 2 0 002-2v-5a2 2 0 012-2h3M11 1.5l2 2-2 2';

export function ViewportControls({
  onPan,
  onZoom,
  onFitPage,
  onFitRoute,
  hasRoute,
  zoom,
}: ViewportControlsProps) {
  const step = 0.28; // fraction of the visible area per nudge

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex items-end gap-2">
      {/* Pan pad */}
      <div className="pointer-events-auto rounded-lg border border-slate-900/10 bg-white/75 p-0.5 shadow-sm backdrop-blur-sm">
        <div className="grid grid-cols-3 grid-rows-3">
          <span />
          <button type="button" className={BUTTON} onClick={() => onPan(0, -step)} title="Pan up">
            <Icon d={CHEVRON_UP} label="Pan up" />
          </button>
          <span />

          <button type="button" className={BUTTON} onClick={() => onPan(-step, 0)} title="Pan left">
            <Icon d={CHEVRON_LEFT} label="Pan left" />
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={onFitPage}
            title="Fit whole page"
          >
            <Icon d={FIT_PAGE} label="Fit whole page" />
          </button>
          <button type="button" className={BUTTON} onClick={() => onPan(step, 0)} title="Pan right">
            <Icon d={CHEVRON_RIGHT} label="Pan right" />
          </button>

          <span />
          <button type="button" className={BUTTON} onClick={() => onPan(0, step)} title="Pan down">
            <Icon d={CHEVRON_DOWN} label="Pan down" />
          </button>
          <span />
        </div>
      </div>

      {/* Zoom column */}
      <div className="pointer-events-auto flex flex-col rounded-lg border border-slate-900/10 bg-white/75 p-0.5 shadow-sm backdrop-blur-sm">
        <button type="button" className={BUTTON} onClick={() => onZoom(1.35)} title="Zoom in">
          <Icon d={PLUS} label="Zoom in" />
        </button>
        <span className="px-1 text-center text-[9px] font-medium tabular-nums text-slate-500">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" className={BUTTON} onClick={() => onZoom(1 / 1.35)} title="Zoom out">
          <Icon d={MINUS} label="Zoom out" />
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={onFitRoute}
          disabled={!hasRoute}
          title="Frame the whole route"
        >
          <Icon d={FIT_ROUTE} label="Frame the whole route" />
        </button>
      </div>
    </div>
  );
}

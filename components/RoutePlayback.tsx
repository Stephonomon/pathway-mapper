'use client';

/**
 * Transport controls for the route tour, overlaid on the document.
 *
 * Mirrors how a navigation app previews a trip: play walks the turns one at a
 * time, and the tour ends by pulling back to frame the whole path.
 */

interface RoutePlaybackProps {
  stepCount: number;
  activeIndex: number;
  playing: boolean;
  phase: 'idle' | 'routing' | 'touring' | 'overview';
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReplay: () => void;
}

const BUTTON =
  'flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium text-slate-700 transition hover:bg-slate-900/10 active:scale-95 disabled:opacity-30 disabled:hover:bg-transparent';

export function RoutePlayback({
  stepCount,
  activeIndex,
  playing,
  phase,
  onPlayPause,
  onPrev,
  onNext,
  onReplay,
}: RoutePlaybackProps) {
  if (stepCount === 0) return null;

  const atEnd = activeIndex >= stepCount - 1;
  const routing = phase === 'routing';

  return (
    <div className="pointer-events-auto absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-slate-900/10 bg-white/80 px-1 py-0.5 shadow-sm backdrop-blur-sm">
      <button type="button" className={BUTTON} onClick={onPrev} disabled={routing || activeIndex <= 0} title="Previous turn">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
          <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {phase === 'overview' || (atEnd && !playing) ? (
        <button type="button" className={BUTTON} onClick={onReplay} disabled={routing} title="Replay the route">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
            <path
              d="M13 8a5 5 0 11-1.6-3.7M13 2v3h-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Replay
        </button>
      ) : (
        <button type="button" className={BUTTON} onClick={onPlayPause} disabled={routing} title={playing ? 'Pause' : 'Play the route'}>
          {playing ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
              <path d="M6 3.5v9M10 3.5v9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
              <path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor" />
            </svg>
          )}
          {playing ? 'Pause' : 'Play'}
        </button>
      )}

      <button type="button" className={BUTTON} onClick={onNext} disabled={routing || atEnd} title="Next turn">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
          <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <span className="px-1.5 text-[11px] tabular-nums text-slate-500">
        {routing ? 'routing…' : phase === 'overview' ? 'full route' : `${activeIndex + 1} / ${stepCount}`}
      </span>
    </div>
  );
}

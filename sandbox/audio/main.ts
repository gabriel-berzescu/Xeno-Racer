/**
 * Audio sandbox entry.
 *
 *   sandbox/audio.html            interactive test bench for humans (default)
 *   sandbox/audio.html?test=1     offline self-test report  -> window.__AUDIO_REPORT__
 *                                 (&only=engines,tires,road,impacts,spatial,ui,music,master,cpu,realtime)
 *   sandbox/audio.html?render=1   renders the preview WAVs  -> window.__AUDIO_WAVS__ (used by render-previews.mjs)
 *
 * window.__READY__ is set when the page is ready (bench) or the run has finished (test / render).
 */
import { type Saved, runGroups } from './report-run';

declare global {
  interface Window {
    __READY__?: boolean;
    __AUDIO_REPORT__?: unknown;
    __AUDIO_WAVS__?: unknown;
    __AUDIO_PROGRESS__?: string;
  }
}

/**
 * The dev server may full-reload the page whenever another engineer saves a file; progress is kept in
 * sessionStorage so a reload resumes with the next group instead of restarting the whole report.
 */
const STORE = 'xr-audio-report-v2';
function loadSaved(only: string | null): Saved {
  try {
    const raw = sessionStorage.getItem(STORE);
    if (raw) {
      const s = JSON.parse(raw) as Saved & { only: string | null };
      if (s.only === only) return s;
    }
  } catch {
    /* ignore */
  }
  return { results: {}, checks: {}, timings: {} };
}

async function runReport(onlyParam: string | null): Promise<void> {
  const out = document.getElementById('out')!;
  const saved = loadSaved(onlyParam);
  try {
    window.__AUDIO_REPORT__ = await runGroups(onlyParam ? onlyParam.split(',') : null, saved, {
      onStart: (g) => {
        window.__AUDIO_PROGRESS__ = `running ${g}`;
      },
      persist: (s) => {
        try {
          sessionStorage.setItem(STORE, JSON.stringify({ ...s, only: onlyParam }));
        } catch {
          /* ignore */
        }
      },
    });
  } catch (e) {
    window.__AUDIO_REPORT__ = { error: String(e), stack: (e as Error).stack };
  }
  out.textContent = JSON.stringify(window.__AUDIO_REPORT__, null, 1).slice(0, 6000);
  // a few hundred offline contexts (each with its own worklet scope) were created: let the browser
  // reclaim them before the page is declared ready
  await new Promise((r) => setTimeout(r, 800));
  window.__AUDIO_PROGRESS__ = 'done';
  window.__READY__ = true;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.has('test')) {
    await runReport(params.get('only'));
  } else if (params.has('render')) {
    const { renderPreviews } = await import('./previews');
    const out = document.getElementById('out')!;
    out.textContent = 'rendering previews…';
    window.__AUDIO_WAVS__ = await renderPreviews((m) => {
      out.textContent = m;
      window.__AUDIO_PROGRESS__ = m;
    });
    out.textContent = 'previews rendered: ' + Object.keys(window.__AUDIO_WAVS__ as Record<string, unknown>).join(', ');
    window.__READY__ = true;
  } else {
    const { startBench } = await import('./bench');
    startBench();
  }
}
void main();

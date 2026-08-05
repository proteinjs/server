/**
 * Dev-only webpack entry that VISIBILITY-GATES the HMR event stream: only visible tabs hold
 * an SSE connection. Each dev tab's hot-update stream occupies one of the browser's 6
 * HTTP/1.1 connection slots to the HMR origin for as long as the tab lives, so accumulated
 * hidden tabs (agent-driven panes especially) can exhaust the pool and starve newly visible
 * tabs of live reload. Closing the stream while hidden frees the slot; catch-up on
 * re-connect is free because webpack-hot-middleware's server publishes its latest build
 * stats ('sync') to every new subscriber, and the stock client hot-applies from that.
 *
 * This file is compiled by the normal package build and injected by absolute dist path as a
 * webpack entry AHEAD of webpack-hot-middleware/client (see createWebpackConfigOverlay), so
 * the EventSource patch below is installed before the client connects. It executes inside
 * the browser bundle: keep it free of imports and Node globals (`process` in particular —
 * webpack's DefinePlugin rewrites `process.env` references).
 */

/**
 * Drop-in for the EventSource the HMR client holds. The client keeps its instance for the
 * page lifetime, so a plain EventSource can't be closed and reopened on visibility changes
 * without the client seeing a dead connection; this gate owns the underlying native
 * connection and creates/destroys it as the tab shows/hides, while the client's handler
 * assignments (onopen/onerror/onmessage — the only surface webpack-hot-middleware/client
 * uses, plus close()) keep working across recreations because they live here, not on the
 * connection.
 */
export class VisibilityGatedEventSource {
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;

  private source: EventSource | null = null;
  private closed = false;

  constructor(private readonly url: string) {
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    // Hidden at construction (the client re-inits after its own disconnect timeout): stay
    // parked with no connection until the tab becomes visible.
    if (document.visibilityState === 'visible') {
      this.connect();
    }
  }

  close(): void {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.disconnect();
  }

  get readyState(): number {
    if (this.closed) {
      return 2; // CLOSED
    }
    // Parked-while-hidden reads as CONNECTING: not closed, will connect on visibility.
    return this.source ? this.source.readyState : 0;
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.disconnect();
    } else if (!this.source) {
      this.connect();
    }
  };

  private connect(): void {
    const source = new nativeEventSource(this.url);
    // Forward through the gate's handler slots so handlers the client assigned once keep
    // firing on every recreated connection.
    source.onopen = (event) => this.onopen && this.onopen(event);
    source.onerror = (event) => this.onerror && this.onerror(event);
    source.onmessage = (event) => this.onmessage && this.onmessage(event);
    this.source = source;
  }

  private disconnect(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }
}

const hmrUrlMarker = '__webpack_hmr';
let nativeEventSource: typeof EventSource;

// Install the patch at module load (this entry precedes the HMR client in the bundle).
// Only the HMR stream URL is gated; every other EventSource on the page is untouched.
(() => {
  if (typeof window === 'undefined' || !window.EventSource || typeof document.visibilityState !== 'string') {
    return; // no browser, no EventSource, or no Page Visibility API — leave native behavior alone
  }

  nativeEventSource = window.EventSource;
  function PatchedEventSource(this: unknown, url: string | URL, init?: EventSourceInit): EventSource {
    return (
      String(url).indexOf(hmrUrlMarker) !== -1
        ? new VisibilityGatedEventSource(String(url))
        : new nativeEventSource(url, init)
    ) as EventSource;
  }
  // Non-HMR instances are genuine natives; sharing the native prototype keeps their
  // `instanceof EventSource` true, and the state constants ride along for code that reads
  // them off the global.
  PatchedEventSource.prototype = nativeEventSource.prototype;
  (PatchedEventSource as any).CONNECTING = nativeEventSource.CONNECTING;
  (PatchedEventSource as any).OPEN = nativeEventSource.OPEN;
  (PatchedEventSource as any).CLOSED = nativeEventSource.CLOSED;
  window.EventSource = PatchedEventSource as unknown as typeof EventSource;
})();

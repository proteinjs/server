import { Server as HttpServer } from 'http';
import { ServerConfig } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';
import { SocketIOServerRepo } from './SocketIOServerRepo';

/** Releases a hold taken with {@link GracefulShutdown.hold}. Idempotent. */
export type HoldRelease = () => void;

/** A hold outstanding on the process: its label plus whatever the holder attached for the logs. */
export type Hold = { label: string; context?: Record<string, unknown> };

/**
 * Follows the process's holds as they come and go — the dev supervisor's lease projection
 * (@n3xah/util-server's ServePackageHold) is the one consumer; it never decides anything here.
 */
export type HoldObserver = { acquired?: (label: string) => void; released?: (label: string) => void };

/**
 * The one owner of the server's shutdown state. Installed by `startServer` before the listener
 * opens; the `/health-check` route reads `isShuttingDown()` — no other flag system exists.
 *
 * Signal / exit-code contract:
 *   SIGTERM → drain, then exit 0:
 *     1. `/health-check` flips to 503 immediately while the listener KEEPS accepting for
 *        `shutdown.drainDelayMs` — load balancers must OBSERVE the failing readiness and
 *        de-register before connections start being refused, or draining becomes user-facing
 *        errors. (In Kubernetes, a preStop sleep buys de-registration time BEFORE the SIGTERM
 *        even arrives; this window makes the server correct regardless of that wiring.)
 *     2. The listener closes (socket.io clients are disconnected, and `io.close()` closes the
 *        http server it is attached to), idle keep-alive connections are closed, and in-flight
 *        requests run to completion.
 *     3. The process WAITS for its HOLDS (`hold(label)` below) to release, bounded by
 *        `shutdown.turnDrainMs`: work that must not die with the process and that no HTTP
 *        connection represents — the canonical holder is a chat turn whose client has gone
 *        (the response detached, the model still writing, nothing persisted yet). Past the
 *        bound every hold still outstanding is logged by label and abandoned.
 *     4. The connection drain is BOUNDED by `shutdown.drainTimeoutMs`: past it, remaining
 *        connections are force-closed. Either way the exit code is 0 — a drained shutdown is
 *        not a crash.
 *   SIGINT → exit 0 immediately (dev ctrl-C: fast and quiet; nothing needs flushing).
 *   exit 86 → NOT this class's concern: `process.exit(86)` is the ServePackageSupervisor
 *     restart-request contract (a liveness monitor giving up on a dependency); it is not
 *     signal-driven and is untouched by these handlers.
 *
 * Holds are a process-wide static seam so a holder never needs the server instance (a turn
 * registry, a suite with no listener): `hold(label, context)` returns the release; the same
 * label held twice is one hold (the release is shared — the turn registry's idempotence);
 * `holds()` lists what is outstanding, in acquisition order; `observeHolds` lets the dev
 * supervisor's lease follow the same set, so a holder declares itself ONCE and both the
 * pre-signal restart deferral (dev) and the post-SIGTERM drain (prod) honor it.
 *
 * Why holds and not connections: the 2026-09-05 prod kill — a phone locked mid-turn, the route
 * detached the dead response and the turn ran on to persist, GKE's autoscaler evicted the pod,
 * and this drain saw NO connection in flight, so `process.exit(0)` ran 5 s after SIGTERM with the
 * model call 32 s in. Nothing persisted, nothing logged (plans/FREE_AGENT.md §M.14).
 *
 * A SIGTERM before the listener is open (mid-boot kill) exits 0 immediately — nothing is
 * registered anywhere and nothing is in flight.
 *
 * Supervisor compatibility (dev): ServePackageSupervisor SIGTERMs the child's process group and
 * escalates to SIGKILL after its grace period (default 10s); its exit handler ignores exit codes
 * for kills it initiated, so the drain-then-exit-0 shape cannot be misread. DEVELOPMENT defaults
 * `drainDelayMs` to 0 so supervised restarts stay fast; a turn in flight under the supervisor is
 * covered BEFORE the signal by its lease (the hold projection), not by this drain.
 */
export class GracefulShutdown {
  private static instance?: GracefulShutdown;
  private static holds = new Map<string, { hold: Hold; release: HoldRelease }>();
  private static holdObservers = new Set<HoldObserver>();
  private static holdWaiters: Array<() => void> = [];
  private static staticLogger = new Logger({ name: 'GracefulShutdown' });
  private shuttingDown = false;
  private logger = new Logger({ name: 'GracefulShutdown' });

  private constructor(
    private server: HttpServer,
    private config: ServerConfig
  ) {}

  /** Install the SIGTERM/SIGINT handlers for this process's server. Idempotent. */
  static install(server: HttpServer, config: ServerConfig): void {
    if (GracefulShutdown.instance) {
      return;
    }
    const instance = new GracefulShutdown(server, config);
    GracefulShutdown.instance = instance;
    process.on('SIGTERM', () => void instance.drainAndExit());
    process.on('SIGINT', () => instance.exitNow());
  }

  /** The readiness seam: `/health-check` reports 503 whenever this is true. */
  static isShuttingDown(): boolean {
    return GracefulShutdown.instance?.shuttingDown ?? false;
  }

  /**
   * Keep the process alive through a SIGTERM drain until the returned release is called (bounded
   * by `shutdown.turnDrainMs`). `label` names the work in the drain's logs (`chat-turn:<id>`);
   * `context` rides beside it (chat id, user id). Holding a label already held returns the
   * existing release — one hold per label.
   */
  static hold(label: string, context?: Record<string, unknown>): HoldRelease {
    const existing = GracefulShutdown.holds.get(label);
    if (existing) {
      return existing.release;
    }
    const release: HoldRelease = () => {
      if (GracefulShutdown.holds.get(label)?.release !== release) {
        return; // already released (or the label re-held since — that hold has its own release)
      }
      GracefulShutdown.holds.delete(label);
      GracefulShutdown.notify('released', label);
      if (GracefulShutdown.holds.size === 0) {
        const waiters = GracefulShutdown.holdWaiters.splice(0, GracefulShutdown.holdWaiters.length);
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
    GracefulShutdown.holds.set(label, { hold: context ? { label, context } : { label }, release });
    GracefulShutdown.notify('acquired', label);
    return release;
  }

  /** Every hold outstanding right now, in acquisition order. */
  static outstandingHolds(): Hold[] {
    return Array.from(GracefulShutdown.holds.values()).map((entry) => ({ ...entry.hold }));
  }

  /** Follow holds as they are acquired and released. Returns the unsubscribe. */
  static observeHolds(observer: HoldObserver): () => void {
    GracefulShutdown.holdObservers.add(observer);
    return () => {
      GracefulShutdown.holdObservers.delete(observer);
    };
  }

  private async drainAndExit(): Promise<void> {
    if (this.shuttingDown) {
      return; // already draining; the sender's escalation is SIGKILL, not a second drain
    }
    this.shuttingDown = true;
    if (!this.server.listening) {
      this.logger.info({ message: `Received SIGTERM before the listener opened — exiting immediately` });
      process.exit(0);
    }
    const drainDelayMs = this.drainDelayMs();
    const drainTimeoutMs = this.drainTimeoutMs();
    const turnDrainMs = this.turnDrainMs();
    this.logger.info({
      message: `Received SIGTERM — /health-check now reports 503; accepting connections for another ${drainDelayMs}ms, then draining in-flight requests (bound: ${drainTimeoutMs}ms) and ${GracefulShutdown.holds.size} hold(s) (bound: ${turnDrainMs}ms)`,
      obj: { holds: GracefulShutdown.outstandingHolds() },
    });
    // 1. Readiness-propagation window: the LB observes the 503 while we still serve normally.
    await this.sleep(drainDelayMs);
    // 2. Stop accepting and drain. The http 'close' event is the drain-complete signal (it
    // fires once the listener is closed AND every connection has ended). socket.io's close()
    // disconnects its clients (websockets would otherwise hold the drain open forever) and
    // closes the http server it is attached to; closeIdleConnections reaps keep-alive
    // connections that are between requests. In-flight requests run to completion.
    const drained = new Promise<void>((resolve) => this.server.once('close', () => resolve()));
    const io = SocketIOServerRepo.getSocketIOServerIfExists();
    if (io) {
      io.close();
    } else {
      this.server.close();
    }
    this.server.closeIdleConnections();
    // 3. Holds: work no connection represents (a detached chat turn). In-flight requests keep
    // running meanwhile — the listener is closed, existing connections are not. Bounded.
    await this.drainHolds(turnDrainMs);
    // 4. Bounded: past the drain timeout, force-close what remains. Exit 0 either way.
    if (!(await this.settled(drained, drainTimeoutMs))) {
      this.logger.warn({
        message: `Drain exceeded its ${drainTimeoutMs}ms bound — force-closing the remaining connections`,
      });
      this.server.closeAllConnections();
    }
    this.logger.info({ message: `Drained — exiting 0` });
    process.exit(0);
  }

  private async drainHolds(turnDrainMs: number): Promise<void> {
    if (GracefulShutdown.holds.size === 0) {
      return;
    }
    this.logger.info({
      message: `Listener closed — waiting for ${GracefulShutdown.holds.size} hold(s) to release (bound: ${turnDrainMs}ms)`,
      obj: { holds: GracefulShutdown.outstandingHolds() },
    });
    if (await this.settled(GracefulShutdown.whenNoHolds(), turnDrainMs)) {
      this.logger.info({ message: `Every hold released — continuing the drain` });
      return;
    }
    const abandoned = GracefulShutdown.outstandingHolds();
    this.logger.warn({
      message: `Hold drain exceeded its ${turnDrainMs}ms bound — abandoning ${abandoned.length} hold(s): ${abandoned
        .map((hold) => hold.label)
        .join(', ')}`,
      obj: { holds: abandoned },
    });
  }

  private exitNow(): void {
    this.shuttingDown = true;
    this.logger.info({ message: `Received SIGINT — exiting immediately` });
    process.exit(0);
  }

  private drainDelayMs(): number {
    if (typeof this.config.shutdown?.drainDelayMs === 'number') {
      return this.config.shutdown.drainDelayMs;
    }
    return process.env.DEVELOPMENT ? 0 : 5000;
  }

  private drainTimeoutMs(): number {
    return this.config.shutdown?.drainTimeoutMs ?? 30_000;
  }

  private turnDrainMs(): number {
    return this.config.shutdown?.turnDrainMs ?? 240_000;
  }

  private static whenNoHolds(): Promise<void> {
    if (GracefulShutdown.holds.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => GracefulShutdown.holdWaiters.push(resolve));
  }

  private static notify(event: 'acquired' | 'released', label: string): void {
    for (const observer of Array.from(GracefulShutdown.holdObservers)) {
      try {
        observer[event]?.(label);
      } catch (error: any) {
        // An observer follows the holds; its failure never touches the hold itself.
        GracefulShutdown.staticLogger.warn({
          message: `A hold observer threw on ${event}`,
          obj: { label, error: error?.message },
        });
      }
    }
  }

  /** Await a promise with a deadline; true if it settled in time. */
  private async settled(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([promise.then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

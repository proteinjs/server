import { Server as HttpServer } from 'http';
import { ServerConfig } from '@proteinjs/server-api';
import { Logger } from '@proteinjs/logger';
import { SocketIOServerRepo } from './SocketIOServerRepo';

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
 *     3. The drain is BOUNDED by `shutdown.drainTimeoutMs`: past it, remaining connections are
 *        force-closed. Either way the exit code is 0 — a drained shutdown is not a crash.
 *   SIGINT → exit 0 immediately (dev ctrl-C: fast and quiet; nothing needs flushing).
 *   exit 86 → NOT this class's concern: `process.exit(86)` is the ServePackageSupervisor
 *     restart-request contract (a liveness monitor giving up on a dependency); it is not
 *     signal-driven and is untouched by these handlers.
 *
 * A SIGTERM before the listener is open (mid-boot kill) exits 0 immediately — nothing is
 * registered anywhere and nothing is in flight.
 *
 * Supervisor compatibility (dev): ServePackageSupervisor SIGTERMs the child's process group and
 * escalates to SIGKILL after its grace period (default 10s); its exit handler ignores exit codes
 * for kills it initiated, so the drain-then-exit-0 shape cannot be misread. DEVELOPMENT defaults
 * `drainDelayMs` to 0 so supervised restarts stay fast.
 */
export class GracefulShutdown {
  private static instance?: GracefulShutdown;
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
    this.logger.info({
      message: `Received SIGTERM — /health-check now reports 503; accepting connections for another ${drainDelayMs}ms, then draining in-flight requests (bound: ${drainTimeoutMs}ms)`,
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
    // 3. Bounded: past the drain timeout, force-close what remains. Exit 0 either way.
    if (!(await this.settled(drained, drainTimeoutMs))) {
      this.logger.warn({
        message: `Drain exceeded its ${drainTimeoutMs}ms bound — force-closing the remaining connections`,
      });
      this.server.closeAllConnections();
    }
    this.logger.info({ message: `Drained — exiting 0` });
    process.exit(0);
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

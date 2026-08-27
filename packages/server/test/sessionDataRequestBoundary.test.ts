import { SessionData } from '@proteinjs/server-api';
import { NodeSessionDataStorage } from '../src/NodeSessionDataStorage';

/**
 * The keep-alive session-bleed class (observed 2026-08-26: after a /dev/login account
 * switch, the home page server-rendered the PREVIOUS account's display name — roster
 * correct, greeting wrong). Mechanism: the storage's init hook copies a populated bag onto
 * every descendant async resource, `setData` is first-write-wins, and a request dispatched
 * on a reused keep-alive socket is born inside the previous request's lineage — so the new
 * request's seed silently loses and the request runs as the prior request's user.
 *
 * These tests pin the hazard AND the request-boundary cure `wrapRoute` now applies:
 * `clearData()` before the seed makes the request's own `setData` authoritative.
 */
describe('session data at the request boundary', () => {
  const storage = new NodeSessionDataStorage();
  const asData = (user: string): SessionData => ({ sessionId: `session-${user}`, user, data: {} });

  /** A continuation born INSIDE the current async context — the keep-alive shape: request B's
   *  dispatch created while request A's lineage still tags the trigger ids. */
  const bornInLineage = (run: () => void): Promise<void> =>
    new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          run();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

  it('pins the hazard: a dispatch born in a prior lineage INHERITS the bag, and a bare re-seed silently loses', async () => {
    storage.setData(asData('account-a'));
    await bornInLineage(() => {
      expect(storage.getData()?.user).toBe('account-a'); // inherited from the trigger lineage
      storage.setData(asData('account-b')); // first-write-wins: this seed is DROPPED
      expect(storage.getData()?.user).toBe('account-a'); // the silent bleed
    });
  });

  it('the request-boundary cure: clearData() then setData makes the new request authoritative', async () => {
    storage.setData(asData('account-a'));
    await bornInLineage(() => {
      // What wrapRoute does per request now: clear the inherited entry, then seed.
      storage.clearData();
      storage.setData(asData('account-b'));
      expect(storage.getData()?.user).toBe('account-b');
    });
  });
});

import { GracefulShutdown } from '../src/GracefulShutdown';

/**
 * The holds seam as a process-wide static contract — what a holder (a chat turn registry) and a
 * follower (the dev supervisor's lease projection) can rely on without a server instance:
 * one hold per label, idempotent release, acquisition-ordered listing with the holder's context,
 * and observers told of every transition exactly once.
 */
describe('GracefulShutdown holds', () => {
  afterEach(() => {
    for (const hold of GracefulShutdown.outstandingHolds()) {
      GracefulShutdown.hold(hold.label)(); // hold() on a held label returns its release
    }
  });

  it('a hold is listed with its context until its release; releasing twice is a no-op', () => {
    const release = GracefulShutdown.hold('chat-turn:t1', { chatId: 'c1', userId: 'u1' });
    expect(GracefulShutdown.outstandingHolds()).toEqual([
      { label: 'chat-turn:t1', context: { chatId: 'c1', userId: 'u1' } },
    ]);
    release();
    expect(GracefulShutdown.outstandingHolds()).toEqual([]);
    release();
    expect(GracefulShutdown.outstandingHolds()).toEqual([]);
  });

  it('holding a label already held is the SAME hold — one entry, one release', () => {
    const first = GracefulShutdown.hold('chat-turn:t2', { chatId: 'c2' });
    const second = GracefulShutdown.hold('chat-turn:t2', { chatId: 'other' });
    expect(second).toBe(first);
    expect(GracefulShutdown.outstandingHolds()).toEqual([{ label: 'chat-turn:t2', context: { chatId: 'c2' } }]);
    second();
    expect(GracefulShutdown.outstandingHolds()).toEqual([]);
  });

  it('a stale release never drops a label re-held since', () => {
    const stale = GracefulShutdown.hold('chat-turn:t3');
    stale();
    const fresh = GracefulShutdown.hold('chat-turn:t3');
    stale(); // the first hold's release, called again after the label was re-held
    expect(GracefulShutdown.outstandingHolds()).toEqual([{ label: 'chat-turn:t3' }]);
    fresh();
    expect(GracefulShutdown.outstandingHolds()).toEqual([]);
  });

  it('lists holds in acquisition order', () => {
    GracefulShutdown.hold('b');
    GracefulShutdown.hold('a');
    expect(GracefulShutdown.outstandingHolds().map((hold) => hold.label)).toEqual(['b', 'a']);
  });

  it('observers see each acquisition and release once; a re-hold of a held label is silent; unsubscribing stops the stream', () => {
    const events: string[] = [];
    const unsubscribe = GracefulShutdown.observeHolds({
      acquired: (label) => events.push(`+${label}`),
      released: (label) => events.push(`-${label}`),
    });
    const release = GracefulShutdown.hold('chat-turn:t4');
    GracefulShutdown.hold('chat-turn:t4');
    release();
    release();
    unsubscribe();
    GracefulShutdown.hold('chat-turn:t5')();
    expect(events).toEqual(['+chat-turn:t4', '-chat-turn:t4']);
  });

  it('a throwing observer never touches the hold', () => {
    const unsubscribe = GracefulShutdown.observeHolds({
      acquired: () => {
        throw new Error('follower down');
      },
      released: () => {
        throw new Error('follower down');
      },
    });
    const release = GracefulShutdown.hold('chat-turn:t6');
    expect(GracefulShutdown.outstandingHolds()).toEqual([{ label: 'chat-turn:t6' }]);
    release();
    expect(GracefulShutdown.outstandingHolds()).toEqual([]);
    unsubscribe();
  });
});

import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import type { Server as SocketIOServer } from 'socket.io';
import { SOCKET_MAX_PAYLOAD_BYTES } from '@proteinjs/server-api';
import { SocketIOServerRepo } from '../src/SocketIOServerRepo';

/**
 * The socket transport's message limit is DECLARED — `SOCKET_MAX_PAYLOAD_BYTES` from
 * @proteinjs/server-api, passed to the transport as its `maxHttpBufferSize` — never inherited
 * from the transport's own default. A client that sends a message over the limit is not answered:
 * the transport closes its socket (ws 1009, "Max payload size exceeded") and socket.io reports a
 * "transport error"; a client that holds a large payload must bound it against the same number
 * before sending. Proven on the real transport: the limit read from the server's options and from
 * the open packet the transport hands every client, then one frame just under the limit delivered
 * and one just over closed.
 */

// The transport's own websocket client, driven raw so the frame on the wire is exactly the bytes
// the limit judges. The package ships no types; this is the sliver used here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require('ws') as new (url: string) => RawSocket;
type RawSocket = {
  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (data: { toString(): string }) => void): void;
  on(event: 'close', handler: (code: number) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
};

/** One connected websocket on the engine transport, joined to socket.io's root namespace. */
type Dial = {
  socket: RawSocket;
  /** The `maxPayload` the transport declared in its open packet — what a client reads as the limit. */
  declaredMaxPayload: number;
  closed: Promise<number>;
};

const waitFor = async (condition: () => boolean, timeoutMs: number, label: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
};

/** A socket.io event frame (`42["echo","…"]`) whose byte length on the wire is exactly `frameBytes`. */
const echoFrameOf = (frameBytes: number): string => {
  const head = '42["echo","';
  const tail = '"]';
  return `${head}${'x'.repeat(frameBytes - head.length - tail.length)}${tail}`;
};

describe("the socket transport's message limit is the declared SOCKET_MAX_PAYLOAD_BYTES", () => {
  let http: HttpServer;
  let io: SocketIOServer;
  let port: number;
  /** The byte length of every `echo` payload the server-side handler received. */
  let received: number[];

  beforeEach(async () => {
    received = [];
    http = createServer();
    io = await SocketIOServerRepo.createSocketIOServer(http);
    io.on('connection', (socket) => {
      socket.on('echo', (text: string) => {
        received.push(Buffer.byteLength(text));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterEach(async () => {
    io.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
    });
    // The repo holds one server per process; the next test builds its own.
    (globalThis as { __proteinjs_server_SocketIOServer?: unknown }).__proteinjs_server_SocketIOServer = undefined;
  });

  const dial = async (): Promise<Dial> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const messages: string[] = [];
    let closeCode: number | undefined;
    const closed = new Promise<number>((resolve) => {
      socket.on('close', (code) => {
        closeCode = code;
        resolve(code);
      });
    });
    socket.on('error', () => undefined);
    socket.on('message', (data) => messages.push(data.toString()));
    await new Promise<void>((resolve) => socket.on('open', resolve));
    // The engine's open packet: `0{"sid":…,"maxPayload":…}` — the limit, as every client reads it.
    await waitFor(() => messages.some((m) => m.startsWith('0')), 2000, 'the engine open packet');
    const open = JSON.parse(messages.find((m) => m.startsWith('0'))!.slice(1)) as { maxPayload: number };
    // Join the root namespace: `40` → `40{"sid":…}`.
    socket.send('40');
    await waitFor(() => messages.some((m) => m.startsWith('40')), 2000, 'the namespace connect ack');
    expect(closeCode).toBeUndefined();
    return { socket, declaredMaxPayload: open.maxPayload, closed };
  };

  it('the transport is built with the declared limit — read from its options and from the open packet it hands a client', async () => {
    expect(io.engine.opts.maxHttpBufferSize).toBe(SOCKET_MAX_PAYLOAD_BYTES);
    const { socket, declaredMaxPayload } = await dial();
    expect(declaredMaxPayload).toBe(SOCKET_MAX_PAYLOAD_BYTES);
    socket.close();
  });

  it('a frame just under the limit is delivered; one just over closes the socket (ws 1009) and is never delivered', async () => {
    const under = await dial();
    under.socket.send(echoFrameOf(SOCKET_MAX_PAYLOAD_BYTES - 1));
    await waitFor(() => received.length === 1, 5000, 'the just-under frame delivered to the handler');
    expect(received[0]).toBe(SOCKET_MAX_PAYLOAD_BYTES - 1 - '42["echo",""]'.length);
    under.socket.close();

    const over = await dial();
    over.socket.send(echoFrameOf(SOCKET_MAX_PAYLOAD_BYTES + 1));
    expect(await over.closed).toBe(1009);
    // The transport dropped the frame whole: the handler never saw a byte of it.
    expect(received).toHaveLength(1);
  }, 15000);
});

/**
 * The most bytes one message on the server's socket transport may carry — engine.io's
 * `maxHttpBufferSize`: a websocket frame, or a long-polling request body. The server passes this
 * to the transport explicitly, so the limit is declared here rather than inherited from the
 * transport's default, and every side reads the one number.
 *
 * A message over the limit is not answered: the transport closes the socket (ws code 1009,
 * "Max payload size exceeded"; socket.io reports the disconnect as "transport error"), and the
 * sender sees nothing but the disconnect. A client that can hold a large payload — a call result,
 * a file's contents — therefore bounds it against THIS number before sending, and refuses readably
 * in its own terms instead of sending a frame the transport will drop.
 *
 * Both sides import the number from here (the server's transport and the clients that bound what
 * they send), so the value is written once. 4 MiB: four times the transport's 1 MB default — a
 * sanity cap on one authenticated client's message, not a product limit; raise it here, nowhere else.
 */
export const SOCKET_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

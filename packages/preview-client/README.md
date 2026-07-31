# `@haneoka/altair-preview-client`

Typed preview transport shared by Altair authoring surfaces and Vega runtime
instances. It uses a private `MessagePort` obtained from a trusted in-process
host or an authenticated one-time iframe bootstrap; wildcard `postMessage`
targets are rejected.

The client validates runtime identity, waits for the capability handshake,
correlates request IDs and monotonic revisions, supports per-request
`AbortSignal`/timeouts, and rejects every pending operation on transport
closure.

The public client includes typed helpers for revisioned scene sync, running a
scene/from a command/snippet, scene-qualified breakpoints, and stage reference
frame/transform inspection. Advanced helpers still check the runtime's
advertised capability list before sending anything.

External iframe authentication is performed before the port is transferred.
The package does not create a WebSocket server or trust arbitrary iframe
messages.

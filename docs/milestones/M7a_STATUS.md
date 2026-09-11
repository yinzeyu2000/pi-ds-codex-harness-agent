# M7a Protocol v2 Transports, Fencing, Deduplication & Watch Cursors Status

Date: 2026-09-07  
Author: yinzeyu2000  

## Completed Deliverables

### 1. Protocol v2 Server Gateway (`packages/agent/src/runtime/server/protocol-v2-server.ts`)
- **Strict 3-Way Handshake**:
  - Requires `hello` (ClientHelloV2) -> `hello` (ServerHelloV2) -> `initialized` (InitializedNotificationV2) handshake sequence.
  - Rejects pre-initialization commands with `protocol_violation` (code 4001).
  - Validates protocol version match (`PROTOCOL_V2_VERSION = 2`), rejecting incompatible clients with `unsupported_version` (code 4002).
- **Concurrent Runtime Loading Race Protection**:
  - Deduplicates simultaneous `ensureRuntime(threadId)` calls across multiple incoming client connections using an in-flight Promise map, preventing generation increments or runtime overwrites.
- **Fast Admission & Wire Command Dispatch**:
  - Supports `controller/acquire`, `controller/release`, `turn/start`, `turn/steer`, `turn/interrupt`, `approval/respond`, and `thread/watch`.
  - Automatic release and revocation notification on connection disconnects.

### 2. Controller Lease & Fencing Engine (`packages/agent/src/runtime/server/controller-lease-manager.ts`)
- **Monotonic ControllerEpoch Progression**:
  - Enforces strictly increasing `ControllerEpoch` counter per thread (`epoch >= 1`).
  - Implements TTL expiry timer (`expiresAt`) and explicit lease acquisition/renewal.
- **Fail-Closed Lease Revocation Listener**:
  - Fires synchronous notifications with exact reason (`released`, `expired`, `superseded`).
  - Ensures stale controllers cannot mutate thread state and triggers fail-closed revocation of in-flight approval requests upon lease loss.
- **Wire Command Fencing**:
  - Verifies epoch on state-mutating commands (`turn/start`, `turn/steer`, `turn/interrupt`, `approval/respond`), rejecting stale or unleased commands with `ControllerFencingError` (wire code 409).

### 3. Request Deduplication & Admission Manager (`packages/agent/src/runtime/server/deduplicator.ts`)
- **Scoped Deduplication Key & Payload Fingerprinting**:
  - Composite key: `(principalId, threadId, method, clientRequestId)`.
  - 64-bit FNV-1a payload hashing with `computePayloadHash`.
- **409 Conflict Detection**:
  - Identical `clientRequestId` with different payload throws `CommandDeduplicationConflictError`.
- **In-Flight Joining & Settled Replay**:
  - Concurrent requests join active promise execution.
  - Completed requests replay cached response envelope identically.
  - LRU capacity bounding (`maxEntries = 5000`) prevents memory leakage.

### 4. Durable Watch & Cursor Manager (`packages/agent/src/runtime/server/durable-watch-manager.ts`)
- **Historical Catchup & Live Stream Handoff**:
  - Captures `ThreadSnapshot` and records `durableWatermarkSeq`.
  - Replays committed historical journal envelopes from `afterSeq` up to watermark sequentially before fanning out live events.
- **Multi-Observer Isolation**:
  - Independent subscription fanout for multiple concurrent observers observing identical deterministic streams.

### 5. Transport Layer & Backpressure Shedding (`packages/agent/src/runtime/server/transports/`)
- **StdioTransport & IpcTransport (`stdio-transport.ts`, `ipc-transport.ts`)**:
  - Node-specific line-delimited JSON framing with robust chunk buffering and clean teardown over `Readable`/`Writable` and `net.Socket` (Windows Named Pipes & Unix Domain Sockets).
  - Browser-safe separation: Node transports isolated in `packages/agent/src/runtime/node.ts`.
- **BoundedOutboundQueue (`bounded-outbound-queue.ts`)**:
  - Protects `ThreadRuntime` from slow or unresponsive clients using high-watermark buffering (`maxQueueSize`, `maxBufferBytes`).
  - Under `drop_live` policy: drops ephemeral live deltas while queue is congested, and automatically synthesizes a `live_gap` envelope once the buffer clears.
  - Under `disconnect` policy: terminates congested client connections cleanly without blocking runtime threads.

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/protocol-v2-handshake.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/protocol-v2-controller-fencing.test.ts` (6 tests passed)
   - `packages/agent/test/runtime/protocol-v2-deduplication.test.ts` (6 tests passed)
   - `packages/agent/test/runtime/protocol-v2-watch-cursors.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/protocol-v2-transports.test.ts` (5 tests passed)
   - **Total M7a Tests**: 23 tests passed across 5 test suites.
   - **Cumulative Runtime Tests**: 25 test suites, 87 tests passed, 0 failures.

2. **Architecture Guards**:
   - `check-m0-baseline.mjs`: OK (16 required artifacts)
   - `check-m1-contracts.mjs`: OK (26 verified artifacts)
   - `check-m2-runtime.mjs`: OK (16 verified artifacts)
   - `check-m3-persistence.mjs`: OK (8 verified artifacts)
   - `check-m4-plugins.mjs`: OK (8 verified artifacts)
   - `check-m5-processes.mjs`: OK (7 verified artifacts)
   - `check-m7a-protocol.mjs`: OK (14 verified artifacts)

3. **Repository Quality Gate**:
   - `npm run check`: 1194 files checked, 0 errors, 0 warnings.
   - Biome formatting & linter: clean.
   - Erasable TypeScript / `tsgo --noEmit`: clean.
   - Browser smoke bundle: clean.

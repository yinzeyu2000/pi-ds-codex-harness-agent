# M7b App Server Multi-UI Integration & Pending Approvals Status

Date: 2026-09-07  
Author: yinzeyu2000  

## Completed Deliverables

### 1. App Server Multi-UI Observer Integration (`packages/agent/src/runtime/server/protocol-v2-server.ts`)
- **Concurrent Observer Streams**:
  - Independent `DurableWatchManager` subscriptions fan out deterministic wire events and live deltas to multiple UI clients concurrently (Headless, CLI, TUI, Web/IDE).
  - Both controller and passive observer connections receive identical ordered event streams without head-of-line blocking or cross-client interference.
- **Controller Fencing & Identity Isolation**:
  - `validateController(state, threadId, epoch)` strictly validates both the monotonic `ControllerEpoch` counter and connection lease ownership (`state.leasedThreads`).
  - Blocks passive observers or stale controllers from executing state-mutating commands (`turn/start`, `turn/steer`, `turn/interrupt`, `approval/respond`), throwing `ControllerFencingError` with code `controller_fencing_error`.
  - Automatic `leasedThreads` clearance upon controller lease release, expiry, or supersession.

### 2. Approval System Wire Integration (`packages/agent/src/runtime/security/approval.ts`, `protocol-v2-server.ts`)
- **Wire Event Broadcasting**:
  - Real-time broadcast of `approval.requested` events across all thread observers when a privileged tool or policy check triggers an approval prompt.
  - Real-time broadcast of `approval.resolved` events with the decision (`approved` / `rejected`) and optional reason to inform all connected observers.
- **Approval Resolution Wire Command (`approval/respond`)**:
  - End-to-end command deduplication via `CommandDeduplicator` preventing duplicate resolutions or race conditions.
  - Controller lease fencing validation guaranteeing that only the active controller client can resolve approval prompts.
  - TOCTOU mitigation: Resolves into `ApprovalManagerImpl` with secondary pre-execution fingerprint validation before tool invocation.
- **Fail-Closed Lease Revocation Defense**:
  - Registered listener on `leaseManager.onAnyLeaseRevoked` immediately cancels all in-flight approval requests on the thread whenever a controller lease is released, expired, or superseded.

### 3. DiagnosticClient SDK (`packages/agent/src/runtime/client/diagnostic-client.ts`)
- **Protocol v2 Client Implementation**:
  - Fully typed high-level client wrapping bidirectional `ProtocolTransport`.
  - Performs 3-way handshake (`hello` -> `hello` -> `initialized`) with timeout safeguards and decoupled message dispatching.
  - Typed methods for `acquireController`, `releaseController`, `watchThread`, `startTurn`, `steerTurn`, `interruptTurn`, and `respondApproval`.
  - Typed event listeners for wire events (`onWireEvent`), live deltas (`onLiveEvent`), and approval lifecycle events (`onApprovalRequested`, `onApprovalResolved`).
  - Exported through public agent runtime barrel (`packages/agent/src/runtime/index.ts`).

### 4. Architecture Guard (`tools/architecture-guards/check-m7b-app-server.mjs`)
- Verifies existence and architectural invariants of:
  - `protocol-v2-server.ts`
  - `controller-lease-manager.ts`
  - `approval.ts`
  - `diagnostic-client.ts`
  - `packages/agent/src/runtime/index.ts`
- Enforces strict integration contracts: approval broadcasting, wire command dispatch, controller fencing, and fail-closed cancellation.

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/protocol-v2-approval-integration.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/protocol-v2-multi-ui.test.ts` (4 tests passed)
   - **Total M7b Tests**: 7 tests passed.
   - **Cumulative Protocol v2 Tests**: 27 tests passed across 6 test suites.

2. **Architecture Guards**:
   - `check-m0-baseline.mjs`: OK (16 required artifacts)
   - `check-m1-contracts.mjs`: OK (26 verified artifacts)
   - `check-m2-runtime.mjs`: OK (16 verified artifacts)
   - `check-m3-persistence.mjs`: OK (8 verified artifacts)
   - `check-m4-plugins.mjs`: OK (8 verified artifacts)
   - `check-m5-processes.mjs`: OK (7 verified artifacts)
   - `check-m6-sandbox.mjs`: OK (10 verified artifacts)
   - `check-m7a-protocol.mjs`: OK (14 verified artifacts)
   - `check-m7b-app-server.mjs`: OK (5 verified artifacts)
   - **All 9 Architecture Guards 100% Green**.

3. **Repository Quality Gate**:
   - `npm run check`: 1205 files checked, 0 errors, 0 warnings.
   - Biome formatting & linter: clean.
   - Erasable TypeScript / `tsgo --noEmit`: clean.
   - Browser smoke bundle: clean.

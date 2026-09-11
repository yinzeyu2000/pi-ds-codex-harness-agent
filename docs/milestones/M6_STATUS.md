# M6 Policy, Approval & Platform Sandbox Status

Date: 2026-09-07  
Author: yinzeyu2000  

## Completed Deliverables

### 1. Host-Owned PermissionProfile & Monotonic Intersection (`packages/agent/src/runtime/security/policy.ts`)
- **Tripartite Security Separation**:
  - `PermissionProfile`: allowed/denied command patterns, allowed filesystem read/write roots, denied paths, network permissions, IPC channels.
  - `ResourceLimits`: timeoutMs, maxMemoryBytes, maxProcesses, maxOutputBytes, maxDiskSpillBytes.
  - `ExecutionEnvironment`: program, args, cwd, envAllowlist, tty, sandboxMode.
- **Strict Monotonic Intersection Rules**:
  - `intersectPermissionProfiles(p1, p2)`: Deny always wins. Command allowlists intersect and denylists union. Filesystem roots narrow down to mutual subpaths and denied paths union. Network access requires mutual authorization; allowed hosts intersect. IPC channels intersect.
  - `intersectResourceLimits(r1, r2)`: Min value strictly wins across all dimensions.
  - `freezeExecutionEnvironment(base, overrides)`: Frozen by host. Overrides can only narrow environment allowlists or enforce stricter isolation; attempts to downgrade sandboxMode (e.g. `secure` -> `trusted-local`) throw explicit errors.

### 2. Approval Lifecycle, SHA-256 Fingerprint & TOCTOU Defense (`packages/agent/src/runtime/security/approval.ts`)
- **Cryptographic Fingerprint Binding**:
  - `computeApprovalFingerprint(input)` produces a canonical 64-character SHA-256 digest over normalized parameters: `(threadId, turnId, toolAttemptId, toolName, command, args, cwd, readRoots, writeRoots, network, sandboxMode, controllerEpoch)`.
  - Any single mutation (altering command/args, shifting working directory, modifying path roots, or advancing `controllerEpoch`) alters the fingerprint deterministically.
- **ApprovalManager Lifecycle (`ApprovalManagerImpl`)**:
  - Asynchronous request and resolution (`approved` vs. `rejected`).
  - Resolution fingerprint check: prevents resolving approval with tampered payload.
  - Expiry deadline: requests exceeding timeout automatically resolve to `expired`.
  - AbortSignal support: immediately rejects pending requests on turn cancellation.
  - Fail-Closed Controller Lease Invalidation: `cancelAllForThread` mass-rejects all pending approvals when controller lease is revoked or epoch changes.
- **TOCTOU Secondary Verification**:
  - `verifyPreExecutionFingerprint` recalculates the SHA-256 fingerprint right before execution dispatch. If arguments or environment changed post-approval, execution is blocked (`status: "denied"`).

### 3. Platform Sandbox Provider & Path Traversal Guards (`packages/agent/src/runtime/security/sandbox-provider.ts`)
- **Path Canonicalization & Traversal Defense**:
  - `canonicalizePath` resolves `.` and `..` segments and Windows drive letters without escaping filesystem root.
  - `validatePathWithinRoots` blocks null-byte attacks (`\0`), directory traversal escapes (`../../`), denied path access, and paths outside configured workspace roots.
- **Fail-Closed Sandbox Enforcement**:
  - `PlatformSandboxProvider` supports `"secure"`, `"trusted-local"`, and `"read-only"` modes.
  - Under `"secure"` mode on unsupported platforms, `evaluate` and `wrapCommand` throw `SandboxUnsupportedError`, failing closed with zero silent unsandboxed fallbacks.
  - Linux `bwrap` container arguments synthesis (`--unshare-net`, `--bind`, `--die-with-parent`).

### 4. ExecutionBroker Security Pipeline Integration (`packages/agent/src/runtime/adapters/execution-broker-impl.ts`)
- Strict execution order:
  1. `coordinator.onAttemptPrepared`
  2. Policy evaluation via `PolicyEngine` (denied commands fail with `status: "denied"`, execute count === 0).
  3. Privileged commands trigger approval workflow through `ApprovalManager`.
  4. Pre-execution TOCTOU fingerprint verification.
  5. Command wrapping via `SandboxProvider`.
  6. Durable write-before-execute barrier (`coordinator.onDispatchIntent`).
  7. `coordinator.onExecutionStarted`.
  8. Supervisor/Tool execution and settlement (`coordinator.onAttemptSettled`).

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/security-policy-intersection.test.ts` (12 tests passed)
   - `packages/agent/test/runtime/security-approval-lifecycle.test.ts` (7 tests passed)
   - `packages/agent/test/runtime/security-sandbox-isolation.test.ts` (10 tests passed)
   - `packages/agent/test/runtime/sandbox-contracts.test.ts` (2 tests passed)
   - **Total M6 Tests**: 31 tests passed across 4 test suites.
   - **Cumulative Runtime Tests**: 28 test suites, 116 tests passed, 0 failures.

2. **Architecture Guards**:
   - `check-m0-baseline.mjs`: OK (16 required artifacts)
   - `check-m1-contracts.mjs`: OK (26 verified artifacts)
   - `check-m2-runtime.mjs`: OK (16 verified artifacts)
   - `check-m3-persistence.mjs`: OK (8 verified artifacts)
   - `check-m4-plugins.mjs`: OK (8 verified artifacts)
   - `check-m5-processes.mjs`: OK (7 verified artifacts)
   - `check-m6-sandbox.mjs`: OK (10 verified artifacts)
   - `check-m7a-protocol.mjs`: OK (14 verified artifacts)

3. **Cross-Platform Baseline**:
   - `scripts/m0-golden-traces.ts`: 4 scenarios match baseline golden traces.

4. **Repository Quality Gate**:
   - `npm run check`: 1202 files checked, 0 errors, 0 warnings.
   - Biome formatting & linter: clean.
   - Erasable TypeScript / `tsgo --noEmit`: clean.
   - Browser smoke bundle: clean.

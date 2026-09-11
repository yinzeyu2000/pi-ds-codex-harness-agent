# M8 Coding Profile & Tool Migration Status

Date: 2026-09-07  
Author: yinzeyu2000  

## Completed Deliverables

### 1. Brokered Coding Tools (`packages/agent/src/runtime/tools/brokered-coding-tools.ts`)
- **Strict ExecutionBroker Routing**:
  - Implemented `createBrokeredReadTool`, `createBrokeredWriteTool`, `createBrokeredEditTool`, `createBrokeredBashTool`, and `createBrokeredCodingTools`.
  - All tool executions strictly route through `broker.prepareAction` and `broker.executeAction`. No direct `node:fs` or `node:child_process` calls.
  - Implements `AgentTool` returning `AgentToolResult<TDetails>` with model-facing `content: [{ type: "text", text }]` and structured `details`.
  - Unwraps raw broker results and nested tool details deterministically.
  - Enforces policy interception and interactive approvals for privileged operations (`bash`, file modification).

### 2. WorkspaceFS Provider & Sandbox Isolation (`packages/agent/src/runtime/security/workspace-fs.ts`)
- **Path Traversal & Root Boundary Defense**:
  - `validatePathWithinRoots`: Enforces that file paths remain strictly inside allowed workspace roots, normalizing paths and blocking symlink escape or traversal attacks (`..`).
- **Filesystem Providers**:
  - `LocalWorkspaceFSProvider`: Production Node filesystem provider using `node:fs/promises` with recursive directory creation, atomic sequential edits, and denied path filtering.
  - `MemoryWorkspaceFSProvider`: Browser-safe and testing provider operating completely in memory with simulated file trees and atomic edit substitution.

### 3. Context Compaction Engine (`packages/agent/src/runtime/compaction/compactor.ts`)
- **Threshold Detection**:
  - `shouldCompact(turnCount, itemCount, estimatedTokens)` detects threshold breaches based on configured `maxTurns`, `maxItems`, and `maxTokens`.
- **Sliding Turn Preservation & Summarization**:
  - `compact(threadId, items)` preserves recent active turns untouched (`keepRecentTurns`) and aggregates older items into an asynchronous summary.
  - Replaces compacted items with a deterministic `notice` ItemSnapshot summarizing previous context.
  - Produces `CompactionJournalFact` (`thread_compacted`) for single-writer journal durability and idempotent replay.

### 4. Pi Extension Compatibility Facade (`packages/agent/src/runtime/plugin/pi-extension-facade.ts`)
- **Bridge to 4-Tier Scope Hierarchy**:
  - Wraps legacy Pi extensions (`PiExtensionEntry`) into the 4-tier Plugin API at `ThreadScope`.
  - Intercepts extension tool registration (`registerTool`) and automatically instruments them via `ExecutionBroker` wrappers.
  - Generates protocol IDs (`asToolAttemptId`, `asToolCallId`, `asTurnId`, `asStepId`) and wraps output into `AgentToolResult<any>`.

### 5. Coding Profile Runtime Composition (`packages/agent/src/runtime/composition/coding-profile.ts`)
- **Assembled Full Stack Coding Environment**:
  - `createCodingRuntimeEnvironment`: Integrates `RuntimeHostImpl`, `HostLifecycleCoordinatorImpl`, `MemoryJournalStore` / `JSONLJournalStore`, `LocalWorkspaceFSProvider` / `MemoryWorkspaceFSProvider`, `ProcessSupervisorImpl`, `PlatformSandboxProvider`, `DefaultPolicyEngine`, `ApprovalManagerImpl`, `ExecutionBrokerImpl`, brokered tools (`read`, `write`, `edit`, `bash`), `CompactionEngine`, and `ProtocolV2Server`.
  - Supports configurable permission profiles and sandbox isolation levels.

### 6. Protocol v2 Client (`packages/agent/src/runtime/client/protocol-v2-client.ts`)
- **Unified Typed Client**:
  - High-level client designed for CLI and TUI sessions.
  - Supports controller acquisition/release, multi-observer event streams, turn execution/steering, and interactive approval responses.

### 7. Architecture Guard (`tools/architecture-guards/check-m8-coding-profile.mjs`)
- Enforces presence and architectural constraints for 9 verified artifacts:
  - `packages/agent/src/runtime/security/workspace-fs.ts`
  - `packages/agent/src/runtime/tools/brokered-coding-tools.ts`
  - `packages/agent/src/runtime/compaction/compactor.ts`
  - `packages/agent/src/runtime/plugin/pi-extension-facade.ts`
  - `packages/agent/src/runtime/composition/coding-profile.ts`
  - `packages/agent/src/runtime/client/protocol-v2-client.ts`
  - `packages/agent/test/runtime/coding-brokered-tools.test.ts`
  - `packages/agent/test/runtime/compaction.test.ts`
  - `packages/agent/test/runtime/coding-profile.test.ts`

---

## Verification Results

1. **Unit & Integration Tests** (Vitest):
   - `packages/agent/test/runtime/coding-brokered-tools.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/compaction.test.ts` (3 tests passed)
   - `packages/agent/test/runtime/coding-profile.test.ts` (1 test passed)
   - **Total M8 Tests**: 7 tests passed.
   - **Cumulative Runtime Tests**: 130 tests passed across 33 test files.

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
   - `check-m8-coding-profile.mjs`: OK (9 verified artifacts)

3. **Workspace Check (`npm run check`)**:
   - Biome formatting and linting: 0 errors, 0 warnings.
   - Pinned dependencies: OK.
   - TypeScript imports: OK.
   - Shrinkwrap & install locks: OK.
   - TypeScript typechecking (`tsgo --noEmit`): 0 errors.
   - Browser smoke test: OK.

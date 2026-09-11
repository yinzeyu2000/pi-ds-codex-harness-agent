# Operational Runbook & Fault Recovery Manual

Date: 2026-09-07  
Author: yinzeyu2000  
Scope: Industrial Runtime Reliability, Recovery, and Security Boundaries  

---

## 1. Architectural Invariants & Guarantees

The pi-ds-codex-harness agent runtime guarantees the **Seven Invariant Uniques**:
1. **Single Foreground State Machine**: `ThreadRuntime` strictly enforces at most one `ActiveTurn` per thread.
2. **Single Agent Loop**: `PiAgentDriver` drives the unified Pi loop with strict event translation.
3. **Single Canonical Durable Journal**: Write-ahead JSONL single-writer journal with monotonic event indexing and crash-recovery verification.
4. **Single ModelGateway Boundary**: Pre-dispatch auditing and model attempt tracking for LLM calls.
5. **Single ExecutionBroker**: All effectful tool actions (process, files, network) route through policy checks, approvals, and sandbox wrapping.
6. **Single 4-Tier Scope Plugin System**: `RuntimeScope -> ThreadScope -> TurnScope -> TaskScope` with transactional LIFO rollback on failure.
7. **Single Protocol v2**: Typed wire protocol with controller lease fencing (`ControllerEpoch`), request deduplication (`clientRequestId`), and durable/live streams.

---

## 2. Crash Recovery & Disaster Procedures

### 2.1 Torn-Tail Log Recovery
- **Symptom**: Process killed mid-write leaving a half-written JSON line at the end of `journal.jsonl`.
- **Automated Mitigation**: `JsonlJournalStore.recover()` scans from the beginning of the journal file. If an invalid or unparseable trailing line is detected, it automatically truncates the corrupted tail to the last valid newline boundary and restores state to the last valid transaction.
- **Manual Verification**: Run `recoverThread(threadId, store)` or verify with `JSON.parse` line by line.

### 2.2 Mid-Log Corruption
- **Symptom**: Bit-flip, bad disk block, or invalid JSON record in the middle of `journal.jsonl`.
- **Fail-Closed Rule**: Mid-log corruption does NOT silently ignore the corrupt line or continue past it. Replay immediately throws `CorruptionError` and stops to prevent state bifurcation or double-execution of actions.
- **Recovery Procedure**:
  1. Isolate the affected thread directory: `data/threads/<threadId>/`.
  2. Inspect `journal.jsonl` using `jq` or line-validator tool.
  3. Extract intact records preceding the corruption into a new `journal.jsonl.recovered`.
  4. Run `replayThreadSnapshot` against the recovered file to verify projection consistency.

### 2.3 Unclean Crash with Incomplete Tool / Model Attempts
- **Symptom**: Host terminated while a tool was executing or an LLM call was in-flight (`started` fact recorded, no `settled` / `completed` fact).
- **Automated Mitigation**:
  - On restart, `recoverThread` identifies incomplete attempts.
  - Incomplete attempts are marked with `outcome: "unknown"` and terminal status `interrupted`.
  - Side-effects without proof-of-non-execution are NEVER automatically retried without user confirmation.

### 2.4 Controller Lease Revocation on Crash
- **Symptom**: Active controller (CLI or TUI) disconnects unexpectedly while holding an active turn.
- **Automated Defense**:
  - Controller lease TTL expires or is superseded by a new controller connection.
  - `leaseManager.onAnyLeaseRevoked` triggers immediate fail-closed cancellation of all pending approvals on the thread.
  - Turn is aborted with `interrupted` status, preventing unauthorized operations from proceeding unattended.

---

## 3. Security Boundaries & Threat Modeling

| Boundary | Enforcement Mechanism | Failure Mode |
|---|---|---|
| **Workspace Boundaries** | `WorkspaceFSProvider` and `validatePathWithinRoots` | Fail-closed: Path traversal (`..`) or symlink escape throws access denied error |
| **Command Execution** | `PlatformSandboxProvider` wrapping process specs | Strict isolation; commands outside allowed profiles rejected |
| **Privileged Tools** | `ApprovalManager` fingerprinting & TOCTOU recheck | Automatic deny if fingerprint changed, timed out, or unconfirmed |
| **Protocol Mutations** | `ControllerLeaseManager` & `ControllerEpoch` checks | Stale or passive clients rejected with `controller_fencing_error` |
| **Request Replay** | `CommandDeduplicator` keyed by `(principal, thread, reqId)` | Returns cached receipt without re-executing actions |
| **Slow/Malicious Observers** | Independent async cursor queues | Backpressure isolated per client; slow observers cannot block runtime |

---

## 4. Operational Monitoring & Health Checks

- **Server Ping**: Protocol v2 clients may issue `ping` requests to verify server responsiveness.
- **Thread Health**: Inspect active turns with `runtime.activeTurn`. A healthy runtime is `idle` (`activeTurn === undefined`) between prompts.
- **Resource Leaks**: Plugin hosts must report `activatedCount === 0` after stop or rollback.

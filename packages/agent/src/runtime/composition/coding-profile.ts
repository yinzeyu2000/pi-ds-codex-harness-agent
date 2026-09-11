import type { ServerCapabilities, ThreadId } from "@earendil-works/pi-protocol";
import { ExecutionBrokerImpl } from "../adapters/execution-broker-impl.ts";
import { type CompactionConfig, CompactionEngine } from "../compaction/compactor.ts";
import { MemoryJournalStore } from "../journal/memory-journal.ts";
import { ProcessSupervisorImpl } from "../process/process-supervisor-impl.ts";
import { HostLifecycleCoordinatorImpl } from "../runtime-host/lifecycle-coordinator-impl.ts";
import { RuntimeHostImpl } from "../runtime-host/runtime-host-impl.ts";
import { ApprovalManagerImpl } from "../security/approval.ts";
import { DefaultPolicyEngine } from "../security/policy.ts";
import { PlatformSandboxProvider } from "../security/sandbox-provider.ts";
import type { PermissionProfile, PolicyEngine, SandboxMode } from "../security/types.ts";
import { LocalWorkspaceFSProvider, MemoryWorkspaceFSProvider } from "../security/workspace-fs.ts";
import { ProtocolV2Server } from "../server/protocol-v2-server.ts";
import { type BrokeredCodingToolsSuite, createBrokeredCodingTools } from "../tools/brokered-coding-tools.ts";
import type { AgentDriver } from "../types/agent-driver.ts";
import type { ThreadJournalStore } from "../types/journal.ts";
import type { ApprovalManager, ProcessSupervisor, SandboxProvider, WorkspaceFSProvider } from "../types/providers.ts";
import type { HostLifecycleCoordinator, RuntimeHost } from "../types/runtime-host.ts";

export interface CodingEnvironmentOptions {
	readonly hostId?: string;
	readonly workspaceRoots: readonly string[];
	readonly inMemoryFS?: boolean;
	readonly initialFiles?: Record<string, Uint8Array | string>;
	readonly journalStore?: ThreadJournalStore;
	readonly permissionProfile?: PermissionProfile;
	readonly sandboxMode?: SandboxMode;
	readonly sandboxProvider?: SandboxProvider;
	readonly policyEngine?: PolicyEngine;
	readonly approvalManager?: ApprovalManager;
	readonly supervisor?: ProcessSupervisor;
	readonly workspaceFS?: WorkspaceFSProvider;
	readonly driverFactory?: (threadId: ThreadId) => AgentDriver;
	readonly compactionConfig?: CompactionConfig;
	readonly serverCapabilities?: Partial<ServerCapabilities>;
}

export interface CodingRuntimeEnvironment {
	readonly host: RuntimeHost;
	readonly coordinator: HostLifecycleCoordinator;
	readonly journalStore: ThreadJournalStore;
	readonly broker: ExecutionBrokerImpl;
	readonly policyEngine: PolicyEngine;
	readonly approvalManager: ApprovalManager;
	readonly sandboxProvider: SandboxProvider;
	readonly supervisor: ProcessSupervisor;
	readonly workspaceFS: WorkspaceFSProvider;
	readonly brokeredTools: BrokeredCodingToolsSuite;
	readonly compactor: CompactionEngine;
	readonly server: ProtocolV2Server;
	close(): Promise<void>;
}

export function createCodingRuntimeEnvironment(options: CodingEnvironmentOptions): CodingRuntimeEnvironment {
	const coordinator = new HostLifecycleCoordinatorImpl();
	const hostId = options.hostId ?? `coding_host_${Date.now()}`;
	const host = new RuntimeHostImpl(hostId, coordinator);

	const journalStore = options.journalStore ?? new MemoryJournalStore();

	const workspaceFS: WorkspaceFSProvider =
		options.workspaceFS ??
		(options.inMemoryFS
			? new MemoryWorkspaceFSProvider(options.initialFiles, options.workspaceRoots)
			: new LocalWorkspaceFSProvider(options.workspaceRoots));

	const supervisor = options.supervisor ?? new ProcessSupervisorImpl();
	const sandboxProvider = options.sandboxProvider ?? new PlatformSandboxProvider();
	const policyEngine = options.policyEngine ?? new DefaultPolicyEngine();
	const approvalManager = options.approvalManager ?? new ApprovalManagerImpl();

	const broker = new ExecutionBrokerImpl({
		supervisor,
		workspaceFS,
		policyEngine,
		permissionProfile: options.permissionProfile,
		approvalManager,
		sandboxProvider,
		sandboxMode: options.sandboxMode,
	});

	const brokeredTools = createBrokeredCodingTools({ broker });

	const compactor = new CompactionEngine(options.compactionConfig);

	const server = new ProtocolV2Server({
		runtimeHost: host,
		journalStore,
		driverFactory: options.driverFactory,
		approvalManager,
		serverCapabilities: options.serverCapabilities,
	});

	return {
		host,
		coordinator,
		journalStore,
		broker,
		policyEngine,
		approvalManager,
		sandboxProvider,
		supervisor,
		workspaceFS,
		brokeredTools,
		compactor,
		server,
		close: async () => {
			await server.close();
		},
	};
}

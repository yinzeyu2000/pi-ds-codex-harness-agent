import type { ControllerLease, ThreadWatchResult, TurnStartResult } from "@earendil-works/pi-protocol";
import type { ProtocolTransport } from "../server/transports/types.ts";
import { DiagnosticClient, type DiagnosticClientOptions } from "./diagnostic-client.ts";

export interface ProtocolV2ClientOptions extends DiagnosticClientOptions {
	readonly autoAcquireController?: boolean;
	readonly defaultThreadId?: string;
}

export class ProtocolV2Client extends DiagnosticClient {
	readonly clientConfig: ProtocolV2ClientOptions;

	constructor(transport: ProtocolTransport, options: ProtocolV2ClientOptions = {}) {
		super(transport, options);
		this.clientConfig = options;
	}

	async connect(threadId?: string): Promise<{
		connectionId: string;
		lease?: ControllerLease;
		watch?: ThreadWatchResult;
	}> {
		const hello = await this.handshake();
		const targetThread = threadId ?? this.clientConfig.defaultThreadId;

		let lease: ControllerLease | undefined;
		let watch: ThreadWatchResult | undefined;

		if (targetThread) {
			watch = await this.watchThread(targetThread);
			if (this.clientConfig.autoAcquireController) {
				lease = await this.acquireController(targetThread);
			}
		}

		return {
			connectionId: hello.connectionId,
			lease,
			watch,
		};
	}

	async executeTurn(threadId: string, prompt: string | unknown, clientRequestId?: string): Promise<TurnStartResult> {
		return this.startTurn(threadId, prompt, clientRequestId);
	}
}

import { PassThrough } from "node:stream";
import { asThreadId, type WireEventEnvelope } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { ProtocolV2Client } from "../../src/runtime/client/protocol-v2-client.ts";
import { createCodingRuntimeEnvironment } from "../../src/runtime/composition/coding-profile.ts";
import { StdioTransport } from "../../src/runtime/server/transports/stdio-transport.ts";
import { FakeDriver } from "../../src/runtime/types/agent-driver.ts";

function createConnectedPair(id: string) {
	const c2s = new PassThrough();
	const s2c = new PassThrough();

	const serverTransport = new StdioTransport(c2s, s2c, { id: `server_${id}` });
	const clientTransport = new StdioTransport(s2c, c2s, { id: `client_${id}` });

	return { serverTransport, clientTransport };
}

describe("M8 Coding Profile Environment & Multi-Client Integration", () => {
	it("assembles complete coding profile runtime environment and executes turns via ProtocolV2Client", async () => {
		const env = createCodingRuntimeEnvironment({
			hostId: "host_coding_e2e",
			workspaceRoots: ["/workspace/app"],
			inMemoryFS: true,
			initialFiles: {
				"/workspace/app/index.ts": "export const app = 'ready';",
			},
			driverFactory: () => new FakeDriver("completed", "Coding agent loop finished"),
		});

		// 1. Connect Controller Client
		const controllerPair = createConnectedPair("ctrl");
		env.server.accept(controllerPair.serverTransport);

		const client = new ProtocolV2Client(controllerPair.clientTransport, {
			autoAcquireController: true,
			clientInfo: { name: "cli-controller" },
		});

		const threadId = asThreadId("th_coding_session");
		const connResult = await client.connect(threadId);

		expect(connResult.connectionId).toBeDefined();
		expect(connResult.lease).toBeDefined();
		expect(connResult.lease?.epoch).toBe(1);
		expect(connResult.watch).toBeDefined();

		// 2. Connect Passive Observer (e.g. Web UI / IDE sidecar)
		const observerPair = createConnectedPair("obs");
		env.server.accept(observerPair.serverTransport);

		const observer = new ProtocolV2Client(observerPair.clientTransport, {
			clientInfo: { name: "tui-observer" },
		});
		await observer.handshake();
		await observer.watchThread(threadId);

		const observerEvents: WireEventEnvelope[] = [];
		observer.onWireEvent((evt) => {
			observerEvents.push(evt);
		});

		// 3. Controller executes a turn
		const turnRes = await client.executeTurn(threadId, "Refactor the module");
		expect(turnRes.status).toBe("admitted");
		expect(turnRes.turnId).toBeDefined();

		// Allow turn execution and event fanout
		await new Promise((r) => setTimeout(r, 60));

		// 4. Verify brokered tools work in environment
		const readRes = await env.brokeredTools.read.execute("call_read_env", {
			path: "/workspace/app/index.ts",
		});
		expect((readRes.details as { content: string }).content).toBe("export const app = 'ready';");

		// Write via brokered tools
		const writeRes = await env.brokeredTools.write.execute("call_write_env", {
			path: "/workspace/app/utils.ts",
			content: "export function add(a: number, b: number) { return a + b; }",
		});
		expect((writeRes.details as { written: boolean }).written).toBe(true);

		const readWritten = await env.brokeredTools.read.execute("call_read_written", {
			path: "/workspace/app/utils.ts",
		});
		expect((readWritten.details as { content: string }).content).toContain("export function add");

		// 5. Clean teardown
		await client.close();
		await observer.close();
		await env.close();
	});
});

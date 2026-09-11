import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ClientMessageV2, ServerMessageV2 } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { connectIpcClient, createIpcServer, type IpcTransport, StdioTransport } from "../../src/runtime/node.ts";
import { BoundedOutboundQueue } from "../../src/runtime/server/transports/bounded-outbound-queue.ts";

describe("Protocol v2 Transports", () => {
	describe("StdioTransport", () => {
		it("frames and parses line-delimited JSON with chunking", async () => {
			const serverIn = new PassThrough();
			const serverOut = new PassThrough();
			const transport = new StdioTransport(serverIn, serverOut);

			const received: ClientMessageV2[] = [];
			transport.onMessage((msg) => {
				received.push(msg);
			});

			const msg: ClientMessageV2 = {
				type: "request",
				id: "req_1",
				request: {
					command: "thread/watch",
					threadId: "t_test",
				},
			};

			const raw = `${JSON.stringify(msg)}\n`;
			// Split raw string across two chunks to test line buffering
			const half1 = raw.slice(0, 10);
			const half2 = raw.slice(10);

			serverIn.write(half1);
			await new Promise((r) => setTimeout(r, 10));
			expect(received).toHaveLength(0);

			serverIn.write(half2);
			await new Promise((r) => setTimeout(r, 20));
			expect(received).toHaveLength(1);
			expect(received[0]).toEqual(msg);

			await transport.close();
		});

		it("emits serialized server messages with trailing newline", async () => {
			const serverIn = new PassThrough();
			const serverOut = new PassThrough();
			const transport = new StdioTransport(serverIn, serverOut);

			let outputData = "";
			serverOut.on("data", (chunk: Buffer | string) => {
				outputData += chunk.toString();
			});

			const srvMsg: ServerMessageV2 = {
				type: "response",
				id: "req_1",
				ok: true,
				result: {
					command: "controller/acquire",
					lease: {
						threadId: "t_test",
						controllerId: "c_1",
						epoch: 1,
						acquiredAt: 0,
						expiresAt: 1000,
					},
				},
			};

			await transport.send(srvMsg);
			await new Promise((r) => setTimeout(r, 20));

			expect(outputData).toBe(`${JSON.stringify(srvMsg)}\n`);
			await transport.close();
		});
	});

	describe("BoundedOutboundQueue", () => {
		it("drops live deltas and synthesizes live_gap when congested under drop_live policy", async () => {
			const sentMessages: ServerMessageV2[] = [];
			let disconnectReason: string | undefined;

			// Slow sender simulating backpressure
			let resolveSlowSend: (() => void) | undefined;
			const slowSender = async (msg: ServerMessageV2) => {
				sentMessages.push(msg);
				if (!resolveSlowSend) {
					await new Promise<void>((resolve) => {
						resolveSlowSend = resolve;
					});
				}
				return true;
			};

			const queue = new BoundedOutboundQueue(
				slowSender,
				(reason) => {
					disconnectReason = reason;
				},
				{ maxQueueSize: 2, onSlowClient: "drop_live" },
			);

			const makeRes = (id: string): ServerMessageV2 => ({
				type: "response",
				id,
				ok: true,
				result: {
					command: "controller/acquire",
					lease: {
						threadId: "t_1",
						controllerId: "c_1",
						epoch: 1,
						acquiredAt: 0,
						expiresAt: 1000,
					},
				},
			});

			// First message starts draining and blocks on slowSender
			const msg1 = makeRes("1");
			expect(queue.enqueue(msg1)).toBe(true);

			// Second message fits into queue
			const msg2 = makeRes("2");
			expect(queue.enqueue(msg2)).toBe(true);

			// Third message is a live delta when queue is full: should be dropped
			const liveMsg: ServerMessageV2 = {
				type: "live",
				event: {
					threadId: "t_1",
					type: "item.delta",
					cursorSeq: 1,
					payload: { text: "chunk" },
					timestamp: Date.now(),
				},
			};
			expect(queue.enqueue(liveMsg)).toBe(false);
			expect(queue.droppedCount).toBe(1);

			// Unblock sender so queue drains
			const unblock = resolveSlowSend!;
			unblock();

			await new Promise((r) => setTimeout(r, 50));

			// After queue clears, live_gap notice should have been emitted
			expect(queue.pendingCount).toBe(0);
			const liveGap = sentMessages.find((m) => m.type === "live" && m.event.type === "live_gap");
			expect(liveGap).toBeDefined();
			expect(disconnectReason).toBeUndefined();

			queue.close();
		});

		it("disconnects when capacity is exceeded under disconnect policy", () => {
			let disconnectReason: string | undefined;
			const slowSender = async () => {
				return new Promise<boolean>(() => {});
			};

			const queue = new BoundedOutboundQueue(
				slowSender,
				(reason) => {
					disconnectReason = reason;
				},
				{ maxQueueSize: 1, onSlowClient: "disconnect" },
			);

			const makeRes = (id: string): ServerMessageV2 => ({
				type: "response",
				id,
				ok: true,
				result: {
					command: "controller/acquire",
					lease: {
						threadId: "t_1",
						controllerId: "c_1",
						epoch: 1,
						acquiredAt: 0,
						expiresAt: 1000,
					},
				},
			});

			const msg1 = makeRes("1");
			expect(queue.enqueue(msg1)).toBe(true);

			const msg2 = makeRes("2");
			expect(queue.enqueue(msg2)).toBe(false);
			expect(disconnectReason).toContain("Outbound queue overflow");

			queue.close();
		});
	});

	describe("IpcTransport", () => {
		it("communicates bi-directionally over local socket / named pipe", async () => {
			const pipeName =
				os.platform() === "win32"
					? `\\\\.\\pipe\\pi-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
					: path.join(os.tmpdir(), `pi-test-${Date.now()}.sock`);

			let serverTransport: IpcTransport | undefined;
			const serverReceived: ClientMessageV2[] = [];
			const clientReceived: ServerMessageV2[] = [];

			const server = createIpcServer(pipeName, (transport) => {
				serverTransport = transport;
				transport.onMessage((msg) => {
					serverReceived.push(msg);
				});
			});

			const clientTransport = await connectIpcClient(pipeName);
			clientTransport.onMessage((msg) => {
				clientReceived.push(msg as unknown as ServerMessageV2);
			});

			// Wait for connection to establish
			await new Promise((r) => setTimeout(r, 50));

			// Client sends to server
			const clientMsg: ClientMessageV2 = {
				type: "request",
				id: "req_ipc_1",
				request: {
					command: "thread/watch",
					threadId: "t_ipc",
				},
			};
			// Cast client message
			await (clientTransport as unknown as { socket: { write: (d: string) => boolean } }).socket.write(
				`${JSON.stringify(clientMsg)}\n`,
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(serverReceived).toHaveLength(1);
			expect(serverReceived[0]).toEqual(clientMsg);

			// Server sends to client
			const srvMsg: ServerMessageV2 = {
				type: "response",
				id: "req_ipc_1",
				ok: true,
				result: {
					command: "controller/acquire",
					lease: {
						threadId: "t_ipc",
						controllerId: "c_ipc",
						epoch: 1,
						acquiredAt: 0,
						expiresAt: 1000,
					},
				},
			};
			await serverTransport?.send(srvMsg);

			await new Promise((r) => setTimeout(r, 50));
			expect(clientReceived).toHaveLength(1);
			expect(clientReceived[0]).toEqual(srvMsg);

			// Cleanup
			await clientTransport.close();
			await serverTransport?.close();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		});
	});
});

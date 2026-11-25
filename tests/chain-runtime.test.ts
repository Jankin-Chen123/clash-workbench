import { test } from "node:test";
import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { ProxyAgent, request } from "undici";
import { emptyWorkspace } from "../shared/types.js";
import { nodesFromRaw } from "../server/importer.js";
import { compileYaml } from "../server/compiler.js";
import { mihomoPath } from "../server/checker.js";

async function listen(server: net.Server) {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as net.AddressInfo).port;
}

function socksFixture(events: number[], sockets: Set<Socket>) {
  return net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let greeted = false;
    function receive(chunk: Buffer) {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        if (buffer.length < 2 || buffer.length < buffer[1] + 2) return;
        buffer = buffer.subarray(buffer[1] + 2);
        socket.write(Buffer.from([5, 0]));
        greeted = true;
      }
      if (buffer.length < 4) return;
      const type = buffer[3];
      const length =
        type === 1 ? 10 : type === 3 && buffer.length > 4 ? 7 + buffer[4] : 0;
      if (!length || buffer.length < length) return;
      const host =
        type === 1
          ? [...buffer.subarray(4, 8)].join(".")
          : buffer.subarray(5, 5 + buffer[4]).toString();
      const port = buffer.readUInt16BE(length - 2);
      events.push(port);
      socket.off("data", receive);
      const pending = buffer.subarray(length);
      const outbound = net.connect(port, host);
      sockets.add(outbound);
      outbound.on("close", () => sockets.delete(outbound));
      outbound.on("error", () => socket.destroy());
      socket.on("close", () => outbound.destroy());
      outbound.once("connect", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (pending.length) outbound.write(pending);
        socket.pipe(outbound);
        outbound.pipe(socket);
      });
    }
    socket.on("data", receive);
  });
}

test(
  "generated dialer-proxy chain carries an HTTP request through entry then exit",
  { timeout: 30_000 },
  async () => {
    const sockets = new Set<Socket>();
    const entryEvents: number[] = [];
    const exitEvents: number[] = [];
    const entry = socksFixture(entryEvents, sockets);
    const exit = socksFixture(exitEvents, sockets);
    const target = http.createServer((_req, res) =>
      res.end("two-hop-confirmed"),
    );
    const entryPort = await listen(entry);
    const exitPort = await listen(exit);
    const targetPort = await listen(target);
    const reserved = net.createServer();
    const mixedPort = await listen(reserved);
    await new Promise<void>((done) => reserved.close(() => done()));
    const directory = await mkdtemp(resolve(tmpdir(), "clash-chain-test-"));
    const workspace = emptyWorkspace();
    workspace.base = {
      "mixed-port": mixedPort,
      "bind-address": "127.0.0.1",
      mode: "rule",
      dns: { enable: false },
      "log-level": "info",
    };
    workspace.nodes = nodesFromRaw(
      [
        { name: "入口", type: "socks5", server: "127.0.0.1", port: entryPort },
        { name: "出口", type: "socks5", server: "127.0.0.1", port: exitPort },
      ],
      "fixture",
    );
    workspace.chains = [
      {
        id: "runtime-chain",
        name: "双跳",
        hops: workspace.nodes.map((node) => node.id),
      },
    ];
    workspace.rules = [{ id: "r", text: "MATCH,双跳", enabled: true }];
    const filename = resolve(directory, "config.yaml");
    await writeFile(filename, compileYaml(workspace));
    const child = spawn(mihomoPath, ["-d", directory, "-f", filename], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on(
      "data",
      (chunk) => (output = (output + chunk).slice(-10000)),
    );
    child.stderr.on(
      "data",
      (chunk) => (output = (output + chunk).slice(-10000)),
    );
    const agent = new ProxyAgent(`http://127.0.0.1:${mixedPort}`);
    try {
      const ready = await new Promise<boolean>((done) => {
        const timer = setInterval(() => {
          if (child.exitCode !== null) {
            clearInterval(timer);
            clearTimeout(deadline);
            done(false);
            return;
          }
          const socket = net.connect(mixedPort, "127.0.0.1");
          socket.once("connect", () => {
            socket.destroy();
            clearInterval(timer);
            clearTimeout(deadline);
            done(true);
          });
          socket.once("error", () => socket.destroy());
        }, 100);
        const deadline = setTimeout(() => {
          clearInterval(timer);
          done(false);
        }, 10_000);
      });
      assert.ok(ready, `Mihomo listener did not start. ${output}`);
      const response = await request(`http://127.0.0.1:${targetPort}/check`, {
        dispatcher: agent,
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(await response.body.text(), "two-hop-confirmed");
      assert.deepEqual(entryEvents, [exitPort]);
      assert.deepEqual(exitEvents, [targetPort]);
    } finally {
      await agent.close();
      child.kill();
      await new Promise<void>((done) => {
        if (child.exitCode !== null) done();
        else child.once("exit", () => done());
      });
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [entry, exit, target].map(
          (server) => new Promise<void>((done) => server.close(() => done())),
        ),
      );
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 100,
      });
    }
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { nodeHttpTransport } from "../src/client/http.js";
import { OparlNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(`{"path":"${req.url}"}`);
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/oparl/system?x=1` });
      assert.equal(resp.status, 200);
      assert.match(resp.body.toString("utf8"), /x=1/);
    },
  );
});

test("rejects an unsupported protocol with OparlNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    OparlNetworkError,
  );
});

test("timeoutMs bounds the whole response, not just idle gaps", async () => {
  // A server that trickles a byte every 50 ms for 2 s never goes idle for the timeout.
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const drip = setInterval(() => res.write(" "), 50);
      const finish = setTimeout(() => res.end("]"), 2000);
      res.on("close", () => {
        clearInterval(drip);
        clearTimeout(finish);
      });
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 300 }),
        (err) => err instanceof OparlNetworkError && /timed out after 300ms/.test(err.message),
      );
      assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    },
  );
});

test("a timeoutMs beyond Node's timer range is capped, not fired after 1 ms", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => void warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await withServer(
      (_req, res) => void setTimeout(() => res.end("{}"), 50),
      async (baseUrl) => {
        const resp = await nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 3_000_000_000 });
        assert.equal(resp.body.toString("utf8"), "{}");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
  } finally {
    process.off("warning", onWarning);
  }
});

test("a request that ends without a response rejects, even with no timeout", async () => {
  // An HTTP 101 carries no body and reaches Node as an `upgrade`, not a response: the
  // promise stayed pending, and with timeoutMs 0 (the documented setting for slow
  // council systems) the event loop simply emptied and the CLI exited 0 with no output.
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}/oparl/system`;
  try {
    for (const timeoutMs of [0, 5000]) {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url, timeoutMs }),
        (err) => err instanceof OparlNetworkError && /HTTP 101 \(protocol upgrade\)/.test(err.message),
        `timeoutMs ${timeoutMs}`,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a header Node refuses to send rejects instead of throwing synchronously", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:1/x", headers: { "User-Agent": "bot \u{1f680}" } }),
    OparlNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        OparlNetworkError,
      );
    },
  );
});

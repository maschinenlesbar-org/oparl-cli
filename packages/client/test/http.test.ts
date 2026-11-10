import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { nodeHttpTransport } from "../src/http.js";
import { OparlNetworkError } from "../src/errors.js";

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

test("a connection cut mid-body, or dropped before any byte, is named as such", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      if (data.toString().startsWith("GET /drop")) {
        socket.destroy();
        return;
      }
      socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"id":"x"');
      setTimeout(() => socket.destroy(), 20);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(
      nodeHttpTransport({ method: "GET", url: `http://127.0.0.1:${port}/cut` }),
      (err: unknown) => err instanceof OparlNetworkError && /closed the connection after 9 bytes of the response, before it was complete/.test(err.message),
    );
    await assert.rejects(
      nodeHttpTransport({ method: "GET", url: `http://127.0.0.1:${port}/drop` }),
      (err: unknown) => err instanceof OparlNetworkError && /closed the connection without sending a response \(socket hang up\)/.test(err.message),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a TLS failure (https to a plain-http server) is one line, without OpenSSL's trailing newline (B04-2)", async () => {
  await withServer(
    (_req, res) => res.end("{}"),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: `${baseUrl.replace("http:", "https:")}/oparl/system`, timeoutMs: 4000 }),
        (err: unknown) => {
          assert.ok(err instanceof OparlNetworkError, String(err));
          assert.doesNotMatch(err.message, /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(err.message));
          assert.equal(err.message, err.message.trim());
          return true;
        },
      );
    },
  );
});

test("a URL typed without its scheme is refused without its user name, token or password (F6)", async () => {
  // `my_user:pw@h` doesn't parse ("_" is no scheme character) and was quoted with its password;
  // `T0kenS3cret:@h` parses with the token as its scheme, which the message named, lower-cased.
  for (const url of ["my_user:s3cret-pw@h.example/x", "T0kenS3cret:@h.example/x", "alice:s3cret-pw@h.example/x"]) {
    const err = await nodeHttpTransport({ method: "GET", url, headers: {} }).then(
      () => assert.fail(`${url}: accepted`),
      (caught: unknown) => caught,
    );
    assert.ok(err instanceof OparlNetworkError, String(err));
    assert.ok(!/s3cret|t0kens3cret|T0kenS3cret|my_user|alice/.test(err.message), err.message);
    assert.match(err.message, /h\.example\/x/);
  }
  // A scheme spelled as one (`scheme://`) is still named; oparl's redactUrl drops a parsed userinfo.
  const ftp = await nodeHttpTransport({ method: "GET", url: "ftp://alice:s3cret-pw@h.example/x", headers: {} }).catch((e: unknown) => e);
  assert.ok(ftp instanceof OparlNetworkError && ftp.message === 'Unsupported protocol "ftp:" in URL: ftp://h.example/x', String(ftp));
});

/** Serve one raw HTTP answer from a TCP server for one test and return its base URL. */
async function withRawServer(answer: Buffer, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(answer));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a body in many tiny chunks arrives whole and in order, and the byte cap still holds (I)", async () => {
  // 300 001 chunks of 1 to 3 bytes: whatever the transport joins on the way, every byte is kept
  // once, in order (the memory side is conformance test P27, the bin in a small heap).
  const pieces = Array.from({ length: 300_001 }, (_, i) => "abc".slice(0, (i % 3) + 1));
  const head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n";
  const wire = Buffer.from(head + pieces.map((p) => `${p.length}\r\n${p}\r\n`).join("") + "0\r\n\r\n", "latin1");
  const expected = pieces.join("");
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, headers: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, expected.length);
    assert.ok(res.body.equals(Buffer.from(expected, "latin1")));
  });
  await withRawServer(wire, async (baseUrl) => {
    await assert.rejects(
      () => nodeHttpTransport({ method: "GET", url: baseUrl, headers: {}, maxResponseBytes: expected.length - 1 }),
      (err: unknown) => err instanceof OparlNetworkError && /exceeded the size limit/.test(err.message),
    );
  });
  await withRawServer(wire, async (baseUrl) => {
    const res = await nodeHttpTransport({ method: "GET", url: baseUrl, headers: {}, maxResponseBytes: expected.length });
    assert.equal(res.body.length, expected.length);
  });
});

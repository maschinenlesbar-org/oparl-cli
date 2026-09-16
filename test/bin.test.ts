// The bin shim (src/cli/index.ts), which the in-process tests never reach: it sets the
// exit code and handles a stdout that closes while the CLI is still writing. Spawns the
// built CLI against a loopback server, the same way test/http.test.ts uses a real socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

/** A System with a bodies list of `count` bodies, big enough to fill a pipe buffer. */
async function serveBodies(count: number): Promise<{ server: Server; systemUrl: string }> {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/system") {
      res.end(JSON.stringify({ id: `${base}/system`, type: "https://schema.oparl.org/1.1/System", oparlVersion: "https://schema.oparl.org/1.1/", body: `${base}/bodies` }));
      return;
    }
    const data = Array.from({ length: count }, (_, i) => ({
      id: `${base}/body/${i}`,
      type: "https://schema.oparl.org/1.1/Body",
      name: `Körperschaft ${i} mit einem langen Namen, damit die Ausgabe groß wird`,
    }));
    res.end(JSON.stringify({ data, links: {} }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, systemUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/system` };
}

test("the bin exits quietly when the reader closes stdout early", async () => {
  const { server, systemUrl } = await serveBodies(4000);
  try {
    const child = spawn(process.execPath, [BIN, "bodies", systemUrl], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Read one chunk, then close the pipe — what `| head -3` does.
    child.stdout.once("data", () => child.stdout.destroy());
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 0, `exit code ${code}; stderr: ${stderr}`);
    assert.doesNotMatch(stderr, /EPIPE|Unhandled|at WriteWrap/, stderr);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("the bin reports a usage error with exit 2 and no stack trace", async () => {
  const child = spawn(process.execPath, [BIN, "get", "ftp://example.org/x"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 2, stderr);
  assert.match(stderr, /Only http: and https: URLs are supported/);
  assert.doesNotMatch(stderr, /at \w+ \(node:/);
});

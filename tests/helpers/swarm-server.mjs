import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/** A scratch directory under .cache, removed by the test runner's clean step. */
export async function scratch(prefix) {
  await mkdir(".cache", { recursive: true });
  return resolve(await mkdtemp(`.cache/${prefix}-`));
}

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * A fake swarm API. `state` is readable by tests; `routes` overrides or adds
 * handlers. Every authenticated route checks the bearer token, so a test fails
 * loudly if the client ever sends the wrong credential.
 */
export async function startSwarm({ slug = "product", token = "token-product", routes = {}, state = {} } = {}) {
  const calls = [];
  const data = {
    posts: [],
    acked: [],
    events: [],
    tasks: [],
    agents: [{ id: "agent-lead", name: "lead" }, { id: "agent-self", name: "backend" }],
    ...state,
  };
  const sockets = new Set();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(`/api/w/${slug}`, "").replace(/^\//, "");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path, query: Object.fromEntries(url.searchParams), body, auth: request.headers.authorization });

    const reply = (payload, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (path === "agents" && request.method === "POST")
      return reply({ agent: { id: "agent-self", name: body.name }, token });
    if (request.headers.authorization !== `Bearer ${token}`)
      return reply({ error: "Unauthorized" }, 401);

    const override = routes[path] ?? routes[`${request.method} ${path}`];
    if (override) return override({ reply, body, url, data, request });

    switch (path) {
      case "me":
        return reply({ id: "agent-self", name: "backend", rooms: ["general"] });
      case "agents":
        return reply({ agents: data.agents });
      case "rooms":
        return reply({ rooms: [{ id: "general" }] });
      case "tasks":
        return request.method === "POST" ? reply({ task: body }, 201) : reply({ tasks: data.tasks });
      case "posts":
        data.posts.push(body);
        return reply({ post: body }, 201);
      case "ack":
        data.acked.push(...body.ids);
        return reply({ acked: body.ids });
      case "inbox":
      case "events":
        return reply({ events: data.events, cursor: data.events.length, hasMore: false });
      case "context":
        return reply({ actor: "agent-self", swarm: `/w/${slug}`, agents: data.agents, tasks: data.tasks });
      case "heartbeat":
        return reply({ status: body.status });
      case "wiki":
        return request.method === "POST"
          ? reply({ page: { id: body.id, revision: body.expectedRevision + 1 } })
          : reply({ pages: [{ id: "index", title: "Index", revision: 2 }] });
      default:
        if (path.startsWith("threads/"))
          return reply({
            root: { id: decodeURIComponent(path.slice(8)), room: "general", author: "agent-lead", body: "Please review" },
            replies: [],
          });
        if (path.startsWith("rooms/")) return reply({ messages: [] });
        return reply({ error: `No fake route for ${path}` }, 404);
    }
  });

  // Minimal WebSocket upgrade: enough for the live inbox to open and be nudged.
  server.on("upgrade", (request, socket) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + WS_MAGIC).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    slug,
    token,
    data,
    calls,
    url: `${origin}/w/${slug}`,
    api: `${origin}/api/w/${slug}`,
    /** Push an unmasked text frame to every live socket. */
    notify(text = JSON.stringify({ type: "inbox" })) {
      const payload = Buffer.from(text);
      const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
      for (const socket of sockets) socket.write(frame);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    },
  };
}

// A newline-delimited JSON-RPC 2.0 server, which is all MCP over stdio needs.
// truffle-plugin pulled in the MCP SDK and zod for this; the protocol surface
// used here is small enough that the dependencies cost more than they saved.

export const PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** Split a byte stream into JSON-RPC messages, tolerating partial chunks. */
export function createFramer(onMessage) {
  let buffer = "";
  return function push(chunk) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(line);
    }
  };
}

/**
 * Dispatch one request. Handlers return a result or throw; a thrown error
 * becomes a protocol error, never an unhandled rejection that kills the server.
 */
export async function dispatch(message, handlers) {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return { jsonrpc: "2.0", id: message.id ?? null, error: { code: INVALID_REQUEST, message: "Not a JSON-RPC 2.0 request." } };
  const handler = handlers[message.method];
  // A notification expects no reply, even for an unknown method.
  if (message.id === undefined || message.id === null)
    return handler ? (await handler(message.params ?? {}), undefined) : undefined;
  if (!handler)
    return { jsonrpc: "2.0", id: message.id, error: { code: METHOD_NOT_FOUND, message: `Unknown method ${message.method}.` } };
  try {
    return { jsonrpc: "2.0", id: message.id, result: (await handler(message.params ?? {})) ?? {} };
  } catch (error) {
    return { jsonrpc: "2.0", id: message.id, error: { code: INTERNAL_ERROR, message: error.message } };
  }
}

/**
 * Serve MCP on a pair of streams. `tools` and `resources` are plain arrays, so
 * registration is data rather than a builder API.
 */
export function serve({ input, output, name, version, instructions, tools = [], resources = [] }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const send = (message) => {
    if (message) output.write(JSON.stringify(message) + "\n");
  };
  const handlers = {
    initialize: () => ({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false }, ...(resources.length ? { resources: { listChanged: false } } : {}) },
      serverInfo: { name, version },
      ...(instructions ? { instructions } : {}),
    }),
    "notifications/initialized": () => undefined,
    ping: () => ({}),
    "tools/list": () => ({
      tools: tools.map(({ name: toolName, description, inputSchema, annotations }) => ({
        name: toolName,
        description,
        inputSchema,
        ...(annotations ? { annotations } : {}),
      })),
    }),
    "tools/call": async ({ name: toolName, arguments: args }) => {
      const tool = byName.get(toolName);
      if (!tool) throw Error(`Unknown tool ${toolName}.`);
      try {
        const result = await tool.run(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        // A tool failure is reported inside the result so the model can react
        // to it, rather than as a protocol error that hides the reason.
        const payload = typeof error.toJSON === "function" ? error.toJSON() : { error: error.message };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
      }
    },
    "resources/list": () => ({
      resources: resources.map(({ uri, name: resourceName, description, mimeType }) => ({
        uri,
        name: resourceName,
        description,
        mimeType,
      })),
    }),
    "resources/read": async ({ uri }) => {
      const resource = resources.find((one) => one.uri === uri);
      if (!resource) throw Error(`Unknown resource ${uri}.`);
      return { contents: [{ uri, mimeType: resource.mimeType, text: JSON.stringify(await resource.read()) }] };
    },
  };
  const push = createFramer(async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Malformed JSON." } });
      return;
    }
    send(await dispatch(message, handlers));
  });
  input.setEncoding("utf8");
  input.on("data", push);
  return { handlers };
}

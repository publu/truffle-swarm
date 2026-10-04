// Node 22 ships a WebSocket client, so the live inbox needs no dependency.
// The socket is only a hint that something arrived; the durable inbox read is
// the source of truth, and it is never acknowledged here.

const HEARTBEAT_MS = 30000;
const READ_TIMEOUT_MS = 20000;

export function liveInboxUrl(api) {
  return `${api.replace(/^http/, "ws")}/live?inbox=1`;
}

/**
 * Resolve as soon as the inbox holds an addressed event, or with the last empty
 * read when the timeout expires on a healthy connection. Connect-then-read, so
 * an event arriving during the first read is still observed.
 */
export function waitForInbox({
  url,
  token,
  readInbox,
  timeoutMs,
  heartbeatMs = HEARTBEAT_MS,
  retryBaseMs = 1000,
  WebSocketImpl = globalThis.WebSocket,
}) {
  return new Promise((resolve, reject) => {
    let socket;
    let retryTimer;
    let pulse;
    let activeRead;
    let lastEmptyRead;
    let failures = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retryTimer);
      clearInterval(pulse);
      activeRead?.abort();
      try {
        socket?.close();
      } catch {
        /* already closing */
      }
      if (error) reject(error);
      else resolve(value);
    };

    const deadline = setTimeout(() => {
      if (lastEmptyRead && socket?.readyState === 1) finish(null, lastEmptyRead);
      else
        finish(
          Error("No live inbox connection was established before the timeout. Check your connection and retry."),
        );
    }, timeoutMs);

    function connect() {
      if (settled) return;
      let current;
      try {
        current = socket = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        finish(Error("This runtime has no WebSocket client. Node.js 22.13 or newer is required."));
        return;
      }
      let reading = false;
      let again = false;
      let awaitingPong = false;
      let openedAt = 0;

      const stale = () => settled || socket !== current || current.readyState !== 1;

      async function check() {
        if (stale()) return;
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        again = false;
        const controller = (activeRead = new AbortController());
        const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
        try {
          const result = await readInbox(controller.signal);
          if (stale()) return;
          if (result.events?.length) finish(null, result);
          else lastEmptyRead = result;
        } catch (error) {
          if (stale()) return;
          // A rejected identity or a bad cursor will not fix itself by retrying.
          if (error.rejectedIdentity || [400, 404, 410].includes(error.status)) finish(error);
          else current.close();
        } finally {
          clearTimeout(timer);
          if (activeRead === controller) activeRead = undefined;
          reading = false;
          if (again) void check();
        }
      }

      current.addEventListener("open", () => {
        openedAt = Date.now();
        void check();
        pulse = setInterval(() => {
          if (stale()) return;
          if (awaitingPong) {
            current.close();
            return;
          }
          awaitingPong = true;
          try {
            current.send("ping");
          } catch {
            current.close();
          }
        }, heartbeatMs);
      });

      current.addEventListener("message", (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (raw === "pong") {
          awaitingPong = false;
          return;
        }
        try {
          if (JSON.parse(raw).type === "inbox") void check();
        } catch {
          // Unknown notification shapes are ignored; their contents are never executed.
        }
      });

      current.addEventListener("error", () => {
        // The close handler owns recovery. Never log headers or credentials.
      });

      current.addEventListener("close", (event) => {
        clearInterval(pulse);
        activeRead?.abort();
        if (settled || socket !== current) return;
        if (event.code === 1008) {
          finish(Error("Swarm access changed. Check this identity's membership before reconnecting."));
          return;
        }
        // A connection that stayed up counts as healthy, so one bad night does
        // not push a long-lived listener into its slowest backoff forever.
        if (openedAt && Date.now() - openedAt >= 30000) failures = 0;
        const backoff = Math.min(60000, retryBaseMs * 2 ** Math.min(failures++, 6));
        retryTimer = setTimeout(connect, backoff * (0.75 + Math.random() * 0.5));
      });
    }

    connect();
  });
}

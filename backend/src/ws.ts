// ws.ts — live WebSocket channel (settlement + wallet updates)
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { verifyAccessToken, AccessClaims } from "./core";
import { onEvent } from "./notify";

const sockets = new Map<number, Set<WebSocket>>();

export function attachWs(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    let userId: number | null = null;
    try {
      const url = new URL(req.url || "/ws", "http://localhost");
      const token = url.searchParams.get("token");
      if (!token) { ws.close(4001, "missing token"); return; }
      const claims: AccessClaims = verifyAccessToken(token);
      userId = claims.uid;
    } catch {
      ws.close(4002, "invalid token");
      return;
    }
    if (!sockets.has(userId!)) sockets.set(userId!, new Set());
    sockets.get(userId!)!.add(ws);

    (ws as any).isAlive = true;
    (ws as any).on("pong", () => { (ws as any).isAlive = true; });
    ws.on("close", () => {
      const set = sockets.get(userId!);
      if (set) { set.delete(ws); if (set.size === 0) sockets.delete(userId!); }
    });

    ws.send(JSON.stringify({ type: "connected", ts: Date.now() }));
  });

  // heartbeat: prune dead connections every 30s
  const interval = setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set as any) {
        if (!ws.isAlive) { set.delete(ws); ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { set.delete(ws); }
      }
    }
  }, 30000);
  wss.on("close", () => clearInterval(interval));

  // relay selected events to online users
  onEvent((ev) => {
    if (ev.type !== "wallet_update" && ev.type !== "settlement" && ev.type !== "kyc_decision") return;
    const targets: number[] = [];
    if (ev.type === "wallet_update") targets.push(ev.payload.userId as number);
    if (ev.type === "settlement") targets.push(ev.payload.payer.userId, ev.payload.payee.userId);
    if (ev.type === "kyc_decision") targets.push(ev.payload.userId as number);
    const msg = JSON.stringify({ type: ev.type, payload: sanitize(ev) });
    for (const uid of targets) {
      const set = sockets.get(uid);
      if (!set) continue;
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch { /* ignore */ } }
      }
    }
  });

  console.log("[ws] live channel attached at /ws");
}

function sanitize(ev: any): any {
  // never leak internal ids to clients beyond what they already know
  if (ev.type === "settlement") {
    const p = ev.payload;
    return {
      txUuid: p.txUuid, amountText: p.amountText, currency: p.currency, txType: p.txType,
      payerBalanceMinor: p.payer.balanceMinor, payeeBalanceMinor: p.payee.balanceMinor,
      payerName: p.payer.name, payeeName: p.payee.name, payerCcy: p.payer.ccy, payeeCcy: p.payee.ccy,
    };
  }
  return ev.payload;
}

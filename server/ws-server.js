import { WebSocketServer } from "ws";
import crypto from "crypto";

import Peer from "./peer.js";
import { hasher } from "./helper.js";

export default class PairDropWsServer {
    constructor(server, conf, storage) {
        this._conf = conf;
        this._storage = storage;

        this._rooms = {}; // { roomId: { peerId: Peer } }
        this._peers = new Map(); // { peerId: Peer }
        this._keepAliveTimers = {};

        this._wss = new WebSocketServer({ server });
        this._wss.on("connection", (socket, request) =>
            this._onConnection(new Peer(socket, request, conf))
        );
    }

    _onConnection(peer) {
        this._peers.set(peer.id, peer);
        peer.socket.on("message", message => this._onMessage(peer, message));
        peer.socket.on("close", () => this._disconnect(peer));
        peer.socket.onerror = e => console.error("WS error:", e.message);

        this._keepAlive(peer);

        this._send(peer, {
            type: "display-name",
            displayName: peer.name.displayName,
            deviceName: peer.name.deviceName,
            isHostDefaultName: !!peer.isHostDefaultName,
            peerId: peer.id,
            peerIdHash: hasher.hashCodeSalted(peer.id),
            roomId: peer.roomId
        });

        // Immediately join default global LAN lobby (or URL-specified room) without IP isolation
        this._joinRoom(peer, peer.roomId || "global");
    }

    _onMessage(sender, rawMessage) {
        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch (e) {
            console.warn("WS: Received JSON is malformed");
            return;
        }

        this._setKeepAliveTimerToNow(sender);

        switch (message.type) {
            case "disconnect":
                this._disconnect(sender);
                break;
            case "pong":
                break;
            case "update-display-name":
                this._onUpdateDisplayName(sender, message);
                break;
            case "create-room":
                this._onCreateRoom(sender);
                break;
            case "join-room":
                this._onJoinRoom(sender, message);
                break;
            case "leave-room":
                this._onLeaveRoom(sender);
                break;
            case "chat-text":
                this._onChatText(sender, message);
                break;
            default:
                console.warn("WS: Unknown message type:", message.type);
        }
    }

    _onUpdateDisplayName(sender, message) {
        if (!sender.updateDisplayName(message.displayName)) return;

        this._send(sender, {
            type: "display-name",
            displayName: sender.name.displayName,
            deviceName: sender.name.deviceName,
            isHostDefaultName: false,
            peerId: sender.id,
            peerIdHash: hasher.hashCodeSalted(sender.id),
            roomId: sender.roomId
        });

        this.broadcastToRoom(sender.roomId, {
            type: "peer-updated",
            peer: sender.getInfo()
        });
    }

    _onCreateRoom(sender) {
        let roomId;
        do {
            roomId = crypto.randomInt(100000, 1000000).toString();
        } while (this._rooms[roomId]);

        this._switchRoom(sender, roomId);
        this._send(sender, {
            type: "room-created",
            roomId
        });
    }

    _onJoinRoom(sender, message) {
        const roomId = String(message.roomId || "").trim();
        if (!Peer.isValidRoomId(roomId)) {
            this._send(sender, {
                type: "room-join-error",
                error: "房间码格式无效，请输入 4-16 位字母或数字（或留空返回全局大厅）"
            });
            return;
        }
        this._switchRoom(sender, roomId);
    }

    _onLeaveRoom(sender) {
        this._switchRoom(sender, "global");
    }

    _switchRoom(peer, targetRoomId) {
        const prevRoomId = peer.roomId;
        if (prevRoomId === targetRoomId && this._rooms[targetRoomId]?.[peer.id]) {
            this._send(peer, { type: "room-joined", roomId: targetRoomId });
            return;
        }

        this._leaveRoom(peer, prevRoomId, false);
        peer.roomId = targetRoomId;
        this._joinRoom(peer, targetRoomId);
        this._send(peer, {
            type: "room-joined",
            roomId: targetRoomId
        });
    }

    _onChatText(sender, message) {
        const rawContent = typeof message.content === "string" ? message.content : "";
        const content = rawContent.trim();
        if (!content || content.length > 50000) return;

        const targetId = Peer.isValidUuid(message.targetId) ? message.targetId : null;
        const saved = this._storage.addMessage({
            id: crypto.randomUUID(),
            roomId: sender.roomId || "global",
            senderId: sender.id,
            senderName: sender.name.displayName,
            targetId,
            msgType: "text",
            content,
            fileId: null,
            createdAt: Date.now()
        });

        if (targetId) {
            // Deliver to target and echo to sender
            this._send(sender, { type: "chat-message-added", message: saved });
            const targetPeer = this._rooms[sender.roomId]?.[targetId];
            if (targetPeer && targetPeer.id !== sender.id) {
                this._send(targetPeer, { type: "chat-message-added", message: saved });
            }
        } else {
            this.broadcastToRoom(sender.roomId, {
                type: "chat-message-added",
                message: saved
            });
        }
    }

    _joinRoom(peer, roomId) {
        if (!this._rooms[roomId]) {
            this._rooms[roomId] = {};
        }

        // Replace stale socket if same peerId reconnected quickly
        const existingPeer = this._rooms[roomId][peer.id];
        if (existingPeer && existingPeer !== peer) {
            this._leaveRoom(existingPeer, roomId, false);
        }

        const otherPeers = [];
        for (const otherId in this._rooms[roomId]) {
            if (otherId === peer.id) continue;
            const otherPeer = this._rooms[roomId][otherId];
            otherPeers.push(otherPeer.getInfo());
            this._send(otherPeer, {
                type: "peer-joined",
                peer: peer.getInfo(),
                roomId
            });
        }

        this._rooms[roomId][peer.id] = peer;

        this._send(peer, {
            type: "peers",
            peers: otherPeers,
            roomId
        });
    }

    _leaveRoom(peer, roomId, disconnect = false) {
        if (!roomId || !this._rooms[roomId] || !this._rooms[roomId][peer.id]) return;
        delete this._rooms[roomId][peer.id];

        if (Object.keys(this._rooms[roomId]).length === 0) {
            delete this._rooms[roomId];
            return;
        }

        for (const otherId in this._rooms[roomId]) {
            this._send(this._rooms[roomId][otherId], {
                type: "peer-left",
                peerId: peer.id,
                roomId,
                disconnect
            });
        }
    }

    _disconnect(peer) {
        if (!this._peers.has(peer.id)) return;
        const current = this._peers.get(peer.id);
        if (current !== peer) return;

        this._peers.delete(peer.id);
        this._cancelKeepAlive(peer);
        delete this._keepAliveTimers[peer.id];

        this._leaveRoom(peer, peer.roomId, true);

        try {
            if (peer.socket.readyState === peer.socket.OPEN || peer.socket.readyState === peer.socket.CONNECTING) {
                peer.socket.terminate();
            }
        } catch (_) {
            // ignore
        }
    }

    broadcastToRoom(roomId, payload) {
        const room = this._rooms[roomId || "global"];
        if (!room) return;
        for (const peerId in room) {
            this._send(room[peerId], payload);
        }
    }

    getRoomPeersCount(roomId = "global") {
        const room = this._rooms[roomId];
        return room ? Object.keys(room).length : 0;
    }

    _send(peer, message) {
        if (!peer || !peer.socket) return;
        if (peer.socket.readyState !== peer.socket.OPEN) return;
        try {
            peer.socket.send(JSON.stringify(message));
        } catch (err) {
            console.warn("WS send failed:", err.message);
        }
    }

    _keepAlive(peer) {
        this._cancelKeepAlive(peer);
        const pingIntervalMs = 5000;
        const timeoutMs = 25000;

        if (!this._keepAliveTimers[peer.id]) {
            this._keepAliveTimers[peer.id] = {
                timer: null,
                lastBeat: Date.now()
            };
        }

        if (Date.now() - this._keepAliveTimers[peer.id].lastBeat > timeoutMs) {
            this._disconnect(peer);
            return;
        }

        this._send(peer, { type: "ping" });
        this._keepAliveTimers[peer.id].timer = setTimeout(() => this._keepAlive(peer), pingIntervalMs);
    }

    _cancelKeepAlive(peer) {
        if (this._keepAliveTimers[peer.id]?.timer) {
            clearTimeout(this._keepAliveTimers[peer.id].timer);
            this._keepAliveTimers[peer.id].timer = null;
        }
    }

    _setKeepAliveTimerToNow(peer) {
        if (this._keepAliveTimers[peer.id]) {
            this._keepAliveTimers[peer.id].lastBeat = Date.now();
        }
    }
}

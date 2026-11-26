import crypto from "crypto";
import parser from "ua-parser-js";
import { hasher } from "./helper.js";

export default class Peer {
    constructor(socket, request, conf) {
        this.conf = conf;
        this.socket = socket;

        this._setIP(request);
        this._setPeerId(request);
        this._setName(request);

        this.requestRate = 0;
        this.roomId = this._resolveInitialRoom(request);
    }

    _resolveInitialRoom(request) {
        try {
            const searchParams = new URL(request.url, "http://server").searchParams;
            const requestedRoom = (searchParams.get("room") || "").trim();
            if (Peer.isValidRoomId(requestedRoom)) {
                return requestedRoom;
            }
        } catch (_) {
            // ignore malformed url
        }
        return "global";
    }

    rateLimitReached() {
        if (this.requestRate >= 20) {
            return true;
        }
        this.requestRate += 1;
        setTimeout(() => (this.requestRate = Math.max(0, this.requestRate - 1)), 10000);
        return false;
    }

    _setIP(request) {
        if (request.headers["cf-connecting-ip"]) {
            this.ip = request.headers["cf-connecting-ip"].split(/\s*,\s*/)[0];
        } else if (request.headers["x-forwarded-for"]) {
            this.ip = request.headers["x-forwarded-for"].split(/\s*,\s*/)[0];
        } else {
            this.ip = request.socket.remoteAddress ?? "";
        }

        if (this.ip.substring(0, 7) === "::ffff:") {
            this.ip = this.ip.substring(7);
        }
    }

    _setPeerId(request) {
        const searchParams = new URL(request.url, "http://server").searchParams;
        const peerId = searchParams.get("peer_id");
        const peerIdHash = searchParams.get("peer_id_hash");
        if (peerId && Peer.isValidUuid(peerId) && this.isPeerIdHashValid(peerId, peerIdHash)) {
            this.id = peerId;
        } else {
            this.id = crypto.randomUUID();
        }
    }

    _isHostMachineRequest(req) {
        const hostHeader = String(req.headers.host || "").toLowerCase();
        const hostOnly = hostHeader.split(":")[0];
        if (hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "::1") {
            return true;
        }
        if (this.ip === "127.0.0.1" || this.ip === "::1") {
            return true;
        }
        if (this.conf?.hostLanIp && this.ip === this.conf.hostLanIp) {
            return true;
        }
        return false;
    }

    _buildFallbackLabel(ua) {
        const model = (ua.device?.model || "").trim();
        const osName = (ua.os?.name || "").trim();
        const osLower = osName.toLowerCase();

        if (model) return model;
        if (osLower.includes("windows")) return "Windows 电脑";
        if (osLower.includes("mac")) return "Mac 电脑";
        if (osLower.includes("ubuntu") || osLower.includes("linux")) return "Linux 电脑";
        if (osLower.includes("ios")) return "iPhone/iPad";
        if (osLower.includes("android")) return "Android 手机";
        return "局域网设备";
    }

    _setName(req) {
        const ua = parser(req.headers["user-agent"]);
        const deviceName = this._buildFallbackLabel(ua);

        const searchParams = new URL(req.url, "http://server").searchParams;
        const customName = (searchParams.get("display_name") || "").trim().slice(0, 40);

        let displayName = customName;
        this.isHostDefaultName = false;

        if (!displayName) {
            if (this._isHostMachineRequest(req) && this.conf?.hostComputerName) {
                displayName = String(this.conf.hostComputerName).trim().slice(0, 40);
                this.isHostDefaultName = true;
            } else {
                displayName = deviceName;
            }
        }

        this.name = {
            model: ua.device?.model || "",
            os: ua.os?.name || "",
            browser: ua.browser?.name || "",
            type: ua.device?.type || "desktop",
            deviceName,
            displayName
        };
    }

    updateDisplayName(newName) {
        const clean = String(newName || "").trim().slice(0, 40);
        if (!clean) return false;
        this.name.displayName = clean;
        this.isHostDefaultName = false;
        return true;
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            roomId: this.roomId
        };
    }

    static isValidUuid(uuid) {
        return /^([0-9]|[a-f]){8}-(([0-9]|[a-f]){4}-){3}([0-9]|[a-f]){12}$/.test(uuid);
    }

    static isValidRoomId(roomId) {
        return roomId === "global" || /^[a-zA-Z0-9_-]{4,16}$/.test(roomId);
    }

    isPeerIdHashValid(peerId, peerIdHash) {
        return peerIdHash === hasher.hashCodeSalted(peerId);
    }
}

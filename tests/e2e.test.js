import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

function waitForHealth(baseUrl, timeoutMs = 10000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const poll = async () => {
            try {
                const res = await fetch(`${baseUrl}/api/health`);
                if (res.ok) {
                    resolve();
                    return;
                }
            } catch (_) {
                // server still booting
            }
            if (Date.now() - start > timeoutMs) {
                reject(new Error("Server healthcheck timeout"));
                return;
            }
            setTimeout(poll, 150);
        };
        poll();
    });
}

function startServer(port, dataDir) {
    const child = spawn(process.execPath, ["server/index.js"], {
        cwd: path.resolve("."),
        env: {
            ...process.env,
            PORT: String(port),
            DATA_DIR: dataDir,
            HOST_LAN_URL: `http://192.168.1.50:${port}`,
            HOST_COMPUTER_NAME: "DEV-HOST-PC"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    return child;
}

function stopServer(child) {
    return new Promise(resolve => {
        if (!child || child.killed) {
            resolve();
            return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
            resolve();
        }, 2000);
    });
}

function connectWsClient(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const queue = [];
        const waiters = [];

        const pushMsg = msg => {
            for (let i = 0; i < waiters.length; i++) {
                if (waiters[i].predicate(msg)) {
                    const w = waiters.splice(i, 1)[0];
                    w.resolve(msg);
                    return;
                }
            }
            queue.push(msg);
        };

        ws.on("message", raw => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }
            pushMsg(msg);
        });

        ws.once("open", () => {
            resolve({
                ws,
                send(obj) {
                    ws.send(JSON.stringify(obj));
                },
                waitFor(predicate, timeoutMs = 5000) {
                    const idx = queue.findIndex(predicate);
                    if (idx >= 0) {
                        return Promise.resolve(queue.splice(idx, 1)[0]);
                    }
                    return new Promise((res, rej) => {
                        const timer = setTimeout(() => {
                            const wIdx = waiters.findIndex(w => w.resolve === res);
                            if (wIdx >= 0) waiters.splice(wIdx, 1);
                            rej(new Error("Timed out waiting for WS message"));
                        }, timeoutMs);
                        waiters.push({
                            predicate,
                            resolve: msg => {
                                clearTimeout(timer);
                                res(msg);
                            }
                        });
                    });
                },
                close() {
                    ws.close();
                }
            });
        });

        ws.once("error", reject);
    });
}

test("E2E: LAN discovery, 6-digit rooms, chat text, inline image, download, batch-delete & persistence", async () => {
    const port = 19010;
    const baseUrl = `http://127.0.0.1:${port}`;
    const wsUrl = `ws://127.0.0.1:${port}`;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-share-e2e-"));

    let serverProc = startServer(port, dataDir);
    try {
        await waitForHealth(baseUrl);

        // 0. Verify pure HTTP static pages and assets load with HTTP 200
        for (const assetPath of ["/", "/styles/lan-share.css", "/scripts/lan-client.js", "/scripts/libs/qr-code.min.js"]) {
            const assetRes = await fetch(`${baseUrl}${assetPath}`);
            assert.equal(assetRes.status, 200, `Expected 200 for ${assetPath}`);
        }

        // 1. Connect two clients -> both see each other immediately in global lobby
        const clientA = await connectWsClient(wsUrl);
        const helloA = await clientA.waitFor(m => m.type === "display-name");
        assert.equal(helloA.displayName, "DEV-HOST-PC");
        assert.equal(helloA.isHostDefaultName, true);
        await clientA.waitFor(m => m.type === "peers");

        const clientB = await connectWsClient(`${wsUrl}/?display_name=Office-Mac`);
        const helloB = await clientB.waitFor(m => m.type === "display-name");
        assert.equal(helloB.displayName, "Office-Mac");
        assert.equal(helloB.isHostDefaultName, false);
        const peersB = await clientB.waitFor(m => m.type === "peers");
        assert.equal(peersB.peers.some(p => p.id === helloA.peerId), true);

        const joinedOnA = await clientA.waitFor(m => m.type === "peer-joined");
        assert.equal(joinedOnA.peer.id, helloB.peerId);

        // 2. Chat text broadcast & persistence
        clientA.send({ type: "chat-text", content: "Hello from PC https://example.com" });
        const msgOnA = await clientA.waitFor(m => m.type === "chat-message-added");
        const msgOnB = await clientB.waitFor(m => m.type === "chat-message-added");
        assert.equal(msgOnA.message.id, msgOnB.message.id);
        assert.equal(msgOnA.message.senderName, "DEV-HOST-PC");
        assert.equal(msgOnA.message.msgType, "text");

        // 3. Upload PNG image -> creates file AND inline image message, safe /preview + Range /download
        const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
        const formImg = new FormData();
        formImg.append("roomId", "global");
        formImg.append("senderId", helloA.peerId);
        formImg.append("senderName", helloA.displayName);
        formImg.append("file", new Blob([pngBytes], { type: "image/png" }), "截图测试.png");

        const upRes = await fetch(`${baseUrl}/api/files/upload`, { method: "POST", body: formImg });
        assert.equal(upRes.status, 201);
        const upJson = await upRes.json();
        assert.equal(upJson.file.isImage, true);
        assert.equal(upJson.file.originalName, "截图测试.png");
        assert.equal(upJson.message.msgType, "image");
        assert.equal(upJson.message.fileId, upJson.file.id);

        const previewRes = await fetch(`${baseUrl}/api/files/${upJson.file.id}/preview`);
        assert.equal(previewRes.status, 200);
        assert.match(previewRes.headers.get("content-disposition") || "", /^inline;/);

        const rangeRes = await fetch(`${baseUrl}/api/files/${upJson.file.id}/download`, {
            headers: { Range: "bytes=0-3" }
        });
        assert.equal(rangeRes.status, 206);
        const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
        assert.deepEqual(rangeBuf, pngBytes.subarray(0, 4));

        // 4. Upload SVG -> blocked from inline /preview (403 XSS guard), allowed via attachment /download
        const formSvg = new FormData();
        formSvg.append("roomId", "global");
        formSvg.append("senderId", helloA.peerId);
        formSvg.append("senderName", helloA.displayName);
        formSvg.append("file", new Blob(["<svg></svg>"], { type: "image/svg+xml" }), "vector.svg");
        const svgUp = await (await fetch(`${baseUrl}/api/files/upload`, { method: "POST", body: formSvg })).json();
        assert.equal(svgUp.file.isImage, false);
        assert.equal(svgUp.message, null);
        const svgPrev = await fetch(`${baseUrl}/api/files/${svgUp.file.id}/preview`);
        assert.equal(svgPrev.status, 403);

        // 5. Create & join 6-digit room without hanging
        clientA.send({ type: "create-room" });
        const createdRoom = await clientA.waitFor(m => m.type === "room-created");
        assert.match(createdRoom.roomId, /^\d{6}$/);

        clientB.send({ type: "join-room", roomId: createdRoom.roomId });
        const joinedRoomB = await clientB.waitFor(m => m.type === "room-joined");
        assert.equal(joinedRoomB.roomId, createdRoom.roomId);

        // Return to global and test batch deletion
        clientA.send({ type: "leave-room" });
        await clientA.waitFor(m => m.type === "room-joined" && m.roomId === "global");

        // Batch delete SVG only; keep PNG and text message for restart persistence check
        const delFileRes = await fetch(`${baseUrl}/api/files/batch-delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [svgUp.file.id], roomId: "global" })
        });
        assert.equal(delFileRes.status, 200);
        const delFileJson = await delFileRes.json();
        assert.deepEqual(delFileJson.deletedFileIds, [svgUp.file.id]);

        clientA.close();
        clientB.close();

        // 6. Restart server with same dataDir and verify persistence
        await stopServer(serverProc);
        serverProc = startServer(port, dataDir);
        await waitForHealth(baseUrl);

        const bootRes = await fetch(`${baseUrl}/api/bootstrap?roomId=global`);
        assert.equal(bootRes.status, 200);
        const bootJson = await bootRes.json();
        assert.equal(bootJson.hostLanUrl, `http://192.168.1.50:${port}`);
        assert.equal(bootJson.files.length, 1);
        assert.equal(bootJson.files[0].id, upJson.file.id);
        assert.equal(bootJson.messages.length, 2); // 1 text + 1 image message
    } finally {
        await stopServer(serverProc);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

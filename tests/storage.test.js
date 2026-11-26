import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import LanShareStorage, { isSafeInlineImage } from "../server/storage.js";

test("isSafeInlineImage allows safe bitmaps and blocks SVG", () => {
    assert.equal(isSafeInlineImage("image/png"), true);
    assert.equal(isSafeInlineImage("image/jpeg; charset=utf-8"), true);
    assert.equal(isSafeInlineImage("image/webp"), true);
    assert.equal(isSafeInlineImage("image/gif"), true);
    assert.equal(isSafeInlineImage("image/svg+xml"), false);
    assert.equal(isSafeInlineImage("text/html"), false);
    assert.equal(isSafeInlineImage("application/pdf"), false);
});

test("LanShareStorage persists messages, files, linked images, and supports batch deletion", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-share-test-"));
    const storage = new LanShareStorage(tmpDir);

    try {
        // 1. Messages persistence & room isolation
        storage.addMessage({
            id: "m1",
            roomId: "global",
            senderId: "p1",
            senderName: "Win PC",
            content: "Hello LAN",
            createdAt: 1000
        });
        storage.addMessage({
            id: "m2",
            roomId: "global",
            senderId: "p2",
            senderName: "iPhone",
            content: "https://example.com",
            createdAt: 2000
        });
        storage.addMessage({
            id: "m3",
            roomId: "123456",
            senderId: "p1",
            senderName: "Win PC",
            content: "Room Only",
            createdAt: 3000
        });

        const globalMsgs = storage.listMessages("global");
        assert.equal(globalMsgs.length, 2);
        assert.equal(globalMsgs[0].id, "m1");
        assert.equal(globalMsgs[1].id, "m2");

        const roomMsgs = storage.listMessages("123456");
        assert.equal(roomMsgs.length, 1);
        assert.equal(roomMsgs[0].id, "m3");

        // 2. File + linked image message persistence
        const imgPath = path.join(storage.uploadsDir, "f-img");
        fs.writeFileSync(imgPath, Buffer.from("fake-png"));
        storage.addFile({
            id: "f-img",
            roomId: "global",
            senderId: "p1",
            senderName: "Win PC",
            originalName: "screenshot.png",
            mimeType: "image/png",
            size: 8,
            storagePath: imgPath,
            createdAt: 2500
        });
        storage.addMessage({
            id: "m-img",
            roomId: "global",
            senderId: "p1",
            senderName: "Win PC",
            msgType: "image",
            content: "screenshot.png",
            fileId: "f-img",
            createdAt: 2500
        });

        const docPath = path.join(storage.uploadsDir, "f-doc");
        fs.writeFileSync(docPath, Buffer.from("hello-doc"));
        storage.addFile({
            id: "f-doc",
            roomId: "global",
            senderId: "p2",
            senderName: "iPhone",
            originalName: "notes.txt",
            mimeType: "text/plain",
            size: 9,
            storagePath: docPath,
            createdAt: 2600
        });

        assert.equal(storage.listFiles("global").length, 2);
        assert.equal(storage.listMessages("global").length, 3);

        // 3. Batch delete files removes disk files, DB files, and linked image messages
        const delResult = storage.deleteFilesBatch(["f-img", "f-doc"], "global");
        assert.deepEqual(delResult.deletedFileIds.sort(), ["f-doc", "f-img"]);
        assert.deepEqual(delResult.deletedMessageIds, ["m-img"]);
        assert.equal(fs.existsSync(imgPath), false);
        assert.equal(fs.existsSync(docPath), false);
        assert.equal(storage.listFiles("global").length, 0);
        assert.equal(storage.listMessages("global").length, 2);

        // 4. Batch delete messages
        const deletedMsgs = storage.deleteMessagesBatch(["m1"], "global");
        assert.deepEqual(deletedMsgs, ["m1"]);
        assert.equal(storage.listMessages("global").length, 1);
        assert.equal(storage.listMessages("global")[0].id, "m2");
    } finally {
        storage.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

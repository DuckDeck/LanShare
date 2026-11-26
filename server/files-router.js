import Busboy from "busboy";
import crypto from "crypto";
import express from "express";
import fs from "fs";
import path from "path";

import Peer from "./peer.js";
import { isSafeInlineImage } from "./storage.js";

const EXT_IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif"
};

function resolveMimeType(originalName, rawMime) {
    const cleanMime = (rawMime || "").toLowerCase().split(";")[0].trim();
    if (cleanMime && cleanMime !== "application/octet-stream") {
        return cleanMime;
    }
    const ext = path.extname(originalName || "").toLowerCase();
    return EXT_IMAGE_MIMES[ext] || cleanMime || "application/octet-stream";
}

function sanitizeFileName(name) {
    const base = path.basename(String(name || "unnamed-file"));
    return base.replace(/[\r\n\0]/g, "_").slice(0, 255) || "unnamed-file";
}

export default function createFilesRouter(storage, wsServer, conf) {
    const router = express.Router();
    const maxFileSizeBytes = (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10240) * 1024 * 1024;

    router.get("/health", (req, res) => {
        res.json({
            status: "ok",
            uptime: Math.floor(process.uptime()),
            timestamp: Date.now()
        });
    });

    router.get("/bootstrap", (req, res) => {
        const requestedRoom = String(req.query.roomId || "global").trim();
        const roomId = Peer.isValidRoomId(requestedRoom) ? requestedRoom : "global";

        const messages = storage.listMessages(roomId, 300);
        const files = storage.listFiles(roomId, 500);

        res.json({
            roomId,
            hostLanUrl: conf.hostLanUrl || null,
            maxFileSizeMb: Math.floor(maxFileSizeBytes / (1024 * 1024)),
            onlinePeersCount: wsServer.getRoomPeersCount(roomId),
            messages,
            files
        });
    });

    router.post("/files/upload", (req, res) => {
        const queryRoom = String(req.query.roomId || "global").trim();
        let roomId = Peer.isValidRoomId(queryRoom) ? queryRoom : "global";
        let senderId = String(req.query.senderId || "unknown");
        let senderName = String(req.query.senderName || "网页设备").slice(0, 80);
        let targetId = Peer.isValidUuid(req.query.targetId) ? req.query.targetId : null;

        let busboy;
        try {
            busboy = Busboy({
                headers: req.headers,
                defParamCharset: "utf8",
                limits: {
                    files: 1,
                    fileSize: maxFileSizeBytes
                }
            });
        } catch (err) {
            res.status(400).json({ error: "无效的上传请求头" });
            return;
        }

        let uploadedFile = null;
        let writeStream = null;
        let tempStoragePath = null;
        let fileId = null;
        let byteCount = 0;
        let aborted = false;
        let limitExceeded = false;
        let responseSent = false;

        const cleanupTempFile = () => {
            if (tempStoragePath && fs.existsSync(tempStoragePath)) {
                try {
                    fs.unlinkSync(tempStoragePath);
                } catch (_) {
                    // ignore
                }
            }
        };

        const sendError = (status, msg) => {
            if (responseSent) return;
            responseSent = true;
            aborted = true;
            if (writeStream) {
                writeStream.destroy();
            }
            cleanupTempFile();
            if (!res.headersSent) {
                res.status(status).json({ error: msg });
            }
        };

        req.on("aborted", () => {
            aborted = true;
            if (writeStream) {
                writeStream.destroy();
            }
            cleanupTempFile();
        });

        busboy.on("field", (name, val) => {
            const value = String(val || "").trim();
            if (name === "roomId" && Peer.isValidRoomId(value)) {
                roomId = value;
            } else if (name === "senderId" && value) {
                senderId = value.slice(0, 64);
            } else if (name === "senderName" && value) {
                senderName = value.slice(0, 80);
            } else if (name === "targetId" && Peer.isValidUuid(value)) {
                targetId = value;
            }
        });

        busboy.on("file", (fieldname, fileStream, info) => {
            if (uploadedFile) {
                fileStream.resume();
                return;
            }

            const originalName = sanitizeFileName(info.filename);
            const mimeType = resolveMimeType(originalName, info.mimeType);
            fileId = crypto.randomUUID();
            tempStoragePath = path.join(storage.uploadsDir, fileId);
            writeStream = fs.createWriteStream(tempStoragePath);

            uploadedFile = {
                id: fileId,
                originalName,
                mimeType,
                storagePath: tempStoragePath
            };

            fileStream.on("data", chunk => {
                byteCount += chunk.length;
            });

            fileStream.on("limit", () => {
                limitExceeded = true;
                fileStream.unpipe(writeStream);
                fileStream.resume();
                sendError(413, `文件超过最大限制 (${Math.floor(maxFileSizeBytes / (1024 * 1024))} MB)`);
            });

            writeStream.on("error", err => {
                console.error("Upload write error:", err);
                sendError(500, "主机写入文件失败，请检查磁盘空间");
            });

            fileStream.pipe(writeStream);
        });

        busboy.on("finish", () => {
            if (aborted || limitExceeded || responseSent) return;
            if (!uploadedFile || !writeStream) {
                sendError(400, "未检测到上传文件");
                return;
            }

            const finalize = () => {
                if (aborted || responseSent) return;
                responseSent = true;

                try {
                    const savedFile = storage.addFile({
                        id: uploadedFile.id,
                        roomId,
                        senderId,
                        senderName,
                        targetId,
                        originalName: uploadedFile.originalName,
                        mimeType: uploadedFile.mimeType,
                        size: byteCount,
                        storagePath: uploadedFile.storagePath,
                        createdAt: Date.now()
                    });

                    wsServer.broadcastToRoom(roomId, {
                        type: "file-added",
                        file: savedFile
                    });

                    let savedMessage = null;
                    if (isSafeInlineImage(uploadedFile.mimeType)) {
                        savedMessage = storage.addMessage({
                            id: crypto.randomUUID(),
                            roomId,
                            senderId,
                            senderName,
                            targetId,
                            msgType: "image",
                            content: uploadedFile.originalName,
                            fileId: savedFile.id,
                            createdAt: savedFile.createdAt
                        });

                        wsServer.broadcastToRoom(roomId, {
                            type: "chat-message-added",
                            message: savedMessage
                        });
                    }

                    res.status(201).json({
                        file: savedFile,
                        message: savedMessage
                    });
                } catch (err) {
                    console.error("DB save error after upload:", err);
                    cleanupTempFile();
                    if (!res.headersSent) {
                        res.status(500).json({ error: "保存文件记录失败" });
                    }
                }
            };

            if (writeStream.writableFinished) {
                finalize();
            } else {
                writeStream.once("finish", finalize);
            }
        });

        busboy.on("error", err => {
            console.error("Busboy error:", err);
            sendError(400, "上传数据解析失败");
        });

        req.pipe(busboy);
    });

    router.get("/files/:id/preview", (req, res) => {
        const file = storage.getFileById(req.params.id);
        if (!file) {
            res.status(404).json({ error: "文件不存在" });
            return;
        }
        if (!isSafeInlineImage(file.mimeType)) {
            res.status(403).json({ error: "该文件类型不支持内联预览" });
            return;
        }

        let safePath;
        try {
            safePath = storage.resolveSafeUploadPath(file.storagePath);
        } catch (err) {
            res.status(403).json({ error: "非法文件路径" });
            return;
        }

        if (!fs.existsSync(safePath)) {
            res.status(404).json({ error: "主机文件已丢失" });
            return;
        }

        res.setHeader("Content-Type", file.mimeType);
        res.setHeader("Content-Length", file.size);
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, max-age=86400");

        const stream = fs.createReadStream(safePath);
        stream.on("error", err => {
            console.error("Preview stream error:", err);
            if (!res.headersSent) res.status(500).end();
        });
        stream.pipe(res);
    });

    router.get("/files/:id/download", (req, res) => {
        const file = storage.getFileById(req.params.id);
        if (!file) {
            res.status(404).json({ error: "文件不存在" });
            return;
        }

        let safePath;
        try {
            safePath = storage.resolveSafeUploadPath(file.storagePath);
        } catch (err) {
            res.status(403).json({ error: "非法文件路径" });
            return;
        }

        if (!fs.existsSync(safePath)) {
            res.status(404).json({ error: "主机文件已丢失" });
            return;
        }

        const stat = fs.statSync(safePath);
        const totalSize = stat.size;
        const range = req.headers.range;

        res.setHeader(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Accept-Ranges", "bytes");

        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match) {
                res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
                return;
            }
            const start = match[1] ? parseInt(match[1], 10) : 0;
            const end = match[2] ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1;
            if (start >= totalSize || end < start) {
                res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).end();
                return;
            }

            if (start === 0) {
                storage.incrementDownloadCount(file.id);
                wsServer.broadcastToRoom(file.roomId, {
                    type: "file-download-updated",
                    fileId: file.id,
                    downloadCount: file.downloadCount + 1
                });
            }

            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
            res.setHeader("Content-Length", end - start + 1);
            res.setHeader("Content-Type", "application/octet-stream");
            fs.createReadStream(safePath, { start, end }).pipe(res);
            return;
        }

        storage.incrementDownloadCount(file.id);
        wsServer.broadcastToRoom(file.roomId, {
            type: "file-download-updated",
            fileId: file.id,
            downloadCount: file.downloadCount + 1
        });

        res.setHeader("Content-Length", totalSize);
        res.setHeader("Content-Type", "application/octet-stream");
        const stream = fs.createReadStream(safePath);
        stream.on("error", err => {
            console.error("Download stream error:", err);
            if (!res.headersSent) res.status(500).end();
        });
        stream.pipe(res);
    });

    router.post("/files/batch-delete", (req, res) => {
        const { ids, roomId } = req.body || {};
        const targetRoom = Peer.isValidRoomId(String(roomId || "global")) ? String(roomId || "global") : "global";

        if (!Array.isArray(ids) || ids.length === 0) {
            res.status(400).json({ error: "请选择要删除的文件" });
            return;
        }

        const { deletedFileIds, deletedMessageIds } = storage.deleteFilesBatch(ids, targetRoom);

        if (deletedFileIds.length > 0) {
            wsServer.broadcastToRoom(targetRoom, {
                type: "files-deleted",
                fileIds: deletedFileIds
            });
        }
        if (deletedMessageIds.length > 0) {
            wsServer.broadcastToRoom(targetRoom, {
                type: "messages-deleted",
                messageIds: deletedMessageIds
            });
        }

        res.json({ deletedFileIds, deletedMessageIds });
    });

    router.post("/messages/batch-delete", (req, res) => {
        const { ids, roomId } = req.body || {};
        const targetRoom = Peer.isValidRoomId(String(roomId || "global")) ? String(roomId || "global") : "global";

        if (!Array.isArray(ids) || ids.length === 0) {
            res.status(400).json({ error: "请选择要删除的消息" });
            return;
        }

        const deletedMessageIds = storage.deleteMessagesBatch(ids, targetRoom);
        if (deletedMessageIds.length > 0) {
            wsServer.broadcastToRoom(targetRoom, {
                type: "messages-deleted",
                messageIds: deletedMessageIds
            });
        }

        res.json({ deletedMessageIds });
    });

    return router;
}

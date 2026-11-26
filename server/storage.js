import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export const SAFE_INLINE_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/bmp",
    "image/avif"
]);

export function isSafeInlineImage(mimeType) {
    if (!mimeType || typeof mimeType !== "string") return false;
    return SAFE_INLINE_IMAGE_MIMES.has(mimeType.toLowerCase().split(";")[0].trim());
}

/**
 * Host-persisted SQLite + upload directory manager.
 * Keeps chat messages (including inline image references) and uploaded files permanently
 * until manually deleted by users.
 */
export default class LanShareStorage {
    constructor(dataDir) {
        this.dataDir = path.resolve(dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data"));
        this.uploadsDir = path.join(this.dataDir, "uploads");
        fs.mkdirSync(this.uploadsDir, { recursive: true });

        this.dbPath = path.join(this.dataDir, "lan-transfer.db");
        this.db = new Database(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");

        this._initSchema();
        this._prepareStatements();
    }

    _initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL DEFAULT 'global',
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                target_id TEXT,
                msg_type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL,
                file_id TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_file_id ON messages(file_id);

            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL DEFAULT 'global',
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                target_id TEXT,
                original_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                storage_path TEXT NOT NULL,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_files_room_time ON files(room_id, created_at DESC);
        `);
    }

    _prepareStatements() {
        this._stmtInsertMessage = this.db.prepare(`
            INSERT INTO messages (id, room_id, sender_id, sender_name, target_id, msg_type, content, file_id, created_at)
            VALUES (@id, @roomId, @senderId, @senderName, @targetId, @msgType, @content, @fileId, @createdAt)
        `);

        this._stmtListMessages = this.db.prepare(`
            SELECT
                m.id,
                m.room_id AS roomId,
                m.sender_id AS senderId,
                m.sender_name AS senderName,
                m.target_id AS targetId,
                m.msg_type AS msgType,
                m.content,
                m.file_id AS fileId,
                m.created_at AS createdAt,
                f.original_name AS fileName,
                f.mime_type AS fileMimeType,
                f.size AS fileSize
            FROM messages m
            LEFT JOIN files f ON m.file_id = f.id
            WHERE m.room_id = ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `);

        this._stmtInsertFile = this.db.prepare(`
            INSERT INTO files (id, room_id, sender_id, sender_name, target_id, original_name, mime_type, size, storage_path, download_count, created_at)
            VALUES (@id, @roomId, @senderId, @senderName, @targetId, @originalName, @mimeType, @size, @storagePath, 0, @createdAt)
        `);

        this._stmtListFiles = this.db.prepare(`
            SELECT
                id,
                room_id AS roomId,
                sender_id AS senderId,
                sender_name AS senderName,
                target_id AS targetId,
                original_name AS originalName,
                mime_type AS mimeType,
                size,
                download_count AS downloadCount,
                created_at AS createdAt
            FROM files
            WHERE room_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `);

        this._stmtGetFileById = this.db.prepare(`
            SELECT
                id,
                room_id AS roomId,
                sender_id AS senderId,
                sender_name AS senderName,
                target_id AS targetId,
                original_name AS originalName,
                mime_type AS mimeType,
                size,
                storage_path AS storagePath,
                download_count AS downloadCount,
                created_at AS createdAt
            FROM files
            WHERE id = ?
        `);

        this._stmtIncDownload = this.db.prepare(`
            UPDATE files SET download_count = download_count + 1 WHERE id = ?
        `);
    }

    addMessage({ id, roomId = "global", senderId, senderName, targetId = null, msgType = "text", content, fileId = null, createdAt = Date.now() }) {
        const record = {
            id,
            roomId,
            senderId,
            senderName,
            targetId: targetId || null,
            msgType,
            content,
            fileId: fileId || null,
            createdAt
        };
        this._stmtInsertMessage.run(record);

        let fileMeta = null;
        if (record.fileId) {
            fileMeta = this.getFileById(record.fileId);
        }

        return {
            ...record,
            fileName: fileMeta ? fileMeta.originalName : null,
            fileMimeType: fileMeta ? fileMeta.mimeType : null,
            fileSize: fileMeta ? fileMeta.size : null
        };
    }

    listMessages(roomId = "global", limit = 300) {
        const rows = this._stmtListMessages.all(roomId, limit);
        return rows.reverse();
    }

    deleteMessagesBatch(ids, roomId = "global") {
        if (!Array.isArray(ids) || ids.length === 0) return [];
        const cleanIds = ids.filter(id => typeof id === "string" && id.length > 0);
        if (cleanIds.length === 0) return [];

        const placeholders = cleanIds.map(() => "?").join(",");
        const selectStmt = this.db.prepare(
            `SELECT id FROM messages WHERE room_id = ? AND id IN (${placeholders})`
        );
        const existing = selectStmt.all(roomId, ...cleanIds).map(r => r.id);
        if (existing.length === 0) return [];

        const existingPlaceholders = existing.map(() => "?").join(",");
        const delStmt = this.db.prepare(
            `DELETE FROM messages WHERE room_id = ? AND id IN (${existingPlaceholders})`
        );
        delStmt.run(roomId, ...existing);
        return existing;
    }

    addFile({ id, roomId = "global", senderId, senderName, targetId = null, originalName, mimeType, size, storagePath, createdAt = Date.now() }) {
        const record = {
            id,
            roomId,
            senderId,
            senderName,
            targetId: targetId || null,
            originalName,
            mimeType: mimeType || "application/octet-stream",
            size,
            storagePath,
            createdAt
        };
        this._stmtInsertFile.run(record);
        return {
            id: record.id,
            roomId: record.roomId,
            senderId: record.senderId,
            senderName: record.senderName,
            targetId: record.targetId,
            originalName: record.originalName,
            mimeType: record.mimeType,
            size: record.size,
            downloadCount: 0,
            createdAt: record.createdAt,
            isImage: isSafeInlineImage(record.mimeType)
        };
    }

    listFiles(roomId = "global", limit = 500) {
        return this._stmtListFiles.all(roomId, limit).map(file => ({
            ...file,
            isImage: isSafeInlineImage(file.mimeType)
        }));
    }

    getFileById(id) {
        if (!id || typeof id !== "string") return null;
        const row = this._stmtGetFileById.get(id);
        if (!row) return null;
        return {
            ...row,
            isImage: isSafeInlineImage(row.mimeType)
        };
    }

    resolveSafeUploadPath(storagePath) {
        const resolved = path.resolve(storagePath);
        const uploadsRoot = path.resolve(this.uploadsDir) + path.sep;
        if (!resolved.startsWith(uploadsRoot)) {
            throw new Error("Invalid file storage path");
        }
        return resolved;
    }

    incrementDownloadCount(id) {
        this._stmtIncDownload.run(id);
    }

    deleteFilesBatch(ids, roomId = "global") {
        if (!Array.isArray(ids) || ids.length === 0) {
            return { deletedFileIds: [], deletedMessageIds: [] };
        }
        const cleanIds = ids.filter(id => typeof id === "string" && id.length > 0);
        if (cleanIds.length === 0) {
            return { deletedFileIds: [], deletedMessageIds: [] };
        }

        const placeholders = cleanIds.map(() => "?").join(",");
        const selectFilesStmt = this.db.prepare(
            `SELECT id, storage_path AS storagePath FROM files WHERE room_id = ? AND id IN (${placeholders})`
        );
        const targetFiles = selectFilesStmt.all(roomId, ...cleanIds);
        if (targetFiles.length === 0) {
            return { deletedFileIds: [], deletedMessageIds: [] };
        }

        const fileIds = targetFiles.map(f => f.id);
        const filePlaceholders = fileIds.map(() => "?").join(",");

        const selectLinkedMsgsStmt = this.db.prepare(
            `SELECT id FROM messages WHERE room_id = ? AND file_id IN (${filePlaceholders})`
        );
        const linkedMessageIds = selectLinkedMsgsStmt.all(roomId, ...fileIds).map(m => m.id);

        const runTx = this.db.transaction(() => {
            if (linkedMessageIds.length > 0) {
                const msgPlaceholders = linkedMessageIds.map(() => "?").join(",");
                this.db.prepare(`DELETE FROM messages WHERE id IN (${msgPlaceholders})`).run(...linkedMessageIds);
            }
            this.db.prepare(`DELETE FROM files WHERE room_id = ? AND id IN (${filePlaceholders})`).run(roomId, ...fileIds);
        });
        runTx();

        // Remove physical files from disk after DB commit
        for (const file of targetFiles) {
            try {
                const safePath = this.resolveSafeUploadPath(file.storagePath);
                if (fs.existsSync(safePath)) {
                    fs.unlinkSync(safePath);
                }
            } catch (err) {
                console.warn(`Failed to unlink file ${file.id}:`, err.message);
            }
        }

        return {
            deletedFileIds: fileIds,
            deletedMessageIds: linkedMessageIds
        };
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

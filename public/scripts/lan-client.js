(() => {
    "use strict";

    const $ = id => document.getElementById(id);

    const state = {
        peerId: sessionStorage.getItem("lan_peer_id") || "",
        peerIdHash: sessionStorage.getItem("lan_peer_id_hash") || "",
        displayName: localStorage.getItem("lan_display_name") || "",
        deviceName: "",
        promptedRenameThisSession: false,
        roomId: resolveInitialRoomFromUrl(),
        hostLanUrl: null,
        peers: [],
        messages: [],
        files: [],
        targetPeerId: null,
        fileFilter: "all",
        chatBatchMode: false,
        selectedMessageIds: new Set(),
        filesBatchMode: false,
        selectedFileIds: new Set(),
        lightboxImages: [],
        lightboxIndex: 0
    };

    let ws = null;
    let reconnectTimer = null;
    let manualDisconnect = false;

    const els = {
        wsStatus: $("ws-status"),
        btnRoom: $("btn-room"),
        currentRoomLabel: $("current-room-label"),
        btnQr: $("btn-qr"),
        btnRename: $("btn-rename"),
        selfNameLabel: $("self-name-label"),
        btnTheme: $("btn-theme"),
        peersCount: $("peers-count"),
        peersList: $("peers-list"),
        badgeChatCount: $("badge-chat-count"),
        badgeFilesCount: $("badge-files-count"),
        panelChat: $("panel-chat"),
        panelFiles: $("panel-files"),
        chatFeed: $("chat-feed"),
        chatForm: $("chat-form"),
        chatInput: $("chat-input"),
        composerTargetBanner: $("composer-target-banner"),
        composerTargetName: $("composer-target-name"),
        btnClearTarget: $("btn-clear-target"),
        btnPickImage: $("btn-pick-image"),
        btnPickFileChat: $("btn-pick-file-chat"),
        inputImageFile: $("input-image-file"),
        inputAnyFile: $("input-any-file"),
        btnPickFiles: $("btn-pick-files"),
        uploadDropzone: $("upload-dropzone"),
        uploadQueue: $("upload-queue"),
        filesSummary: $("files-summary"),
        filesList: $("files-list"),
        globalDropOverlay: $("global-drop-overlay"),
        // Chat batch controls
        btnChatBatchToggle: $("btn-chat-batch-toggle"),
        chatBatchBar: $("chat-batch-bar"),
        chkChatSelectAll: $("chk-chat-select-all"),
        chatSelectedCount: $("chat-selected-count"),
        btnChatDeleteSelected: $("btn-chat-delete-selected"),
        btnChatBatchCancel: $("btn-chat-batch-cancel"),
        // Files batch controls
        btnFilesBatchToggle: $("btn-files-batch-toggle"),
        filesBatchBar: $("files-batch-bar"),
        chkFilesSelectAll: $("chk-files-select-all"),
        filesSelectedCount: $("files-selected-count"),
        btnFilesDeleteSelected: $("btn-files-delete-selected"),
        btnFilesBatchCancel: $("btn-files-batch-cancel"),
        // Dialogs
        dialogRoom: $("dialog-room"),
        modalRoomCurrent: $("modal-room-current"),
        btnCreateRoom: $("btn-create-room"),
        formJoinRoom: $("form-join-room"),
        inputRoomCode: $("input-room-code"),
        btnLeaveRoom: $("btn-leave-room"),
        dialogQr: $("dialog-qr"),
        qrContainer: $("qr-container"),
        qrUrlText: $("qr-url-text"),
        qrHintText: $("qr-hint-text"),
        btnCopyQrUrl: $("btn-copy-qr-url"),
        dialogRename: $("dialog-rename"),
        formRename: $("form-rename"),
        inputDisplayName: $("input-display-name"),
        dialogLightbox: $("dialog-lightbox"),
        lightboxImg: $("lightbox-img"),
        lightboxCaption: $("lightbox-caption"),
        btnLightboxPrev: $("btn-lightbox-prev"),
        btnLightboxNext: $("btn-lightbox-next"),
        btnLightboxDownload: $("btn-lightbox-download"),
        toastContainer: $("toast-container")
    };

    function resolveInitialRoomFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const room = (params.get("room") || "").trim();
        if (/^[a-zA-Z0-9_-]{4,16}$/.test(room)) {
            return room;
        }
        return "global";
    }

    function syncRoomToUrl(roomId) {
        const url = new URL(window.location.href);
        if (roomId && roomId !== "global") {
            url.searchParams.set("room", roomId);
        } else {
            url.searchParams.delete("room");
        }
        window.history.replaceState({}, "", url.toString());
    }

    function initTheme() {
        const apply = mode => {
            const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
            const dark = mode === "dark" || (mode === "auto" && prefersDark);
            document.body.classList.toggle("dark-theme", dark);
        };
        const saved = localStorage.getItem("lan_theme") || "auto";
        apply(saved);
        els.btnTheme.addEventListener("click", () => {
            const cur = localStorage.getItem("lan_theme") || "auto";
            const next = cur === "auto" ? "dark" : cur === "dark" ? "light" : "auto";
            localStorage.setItem("lan_theme", next);
            apply(next);
            showToast(next === "auto" ? "主题：跟随系统" : next === "dark" ? "主题：深色" : "主题：浅色");
        });
    }

    function showToast(text, isError = false) {
        const div = document.createElement("div");
        div.className = "toast" + (isError ? " error" : "");
        div.textContent = text;
        els.toastContainer.appendChild(div);
        setTimeout(() => div.remove(), 2600);
    }

    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {
                // fallback below
            }
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch (_) {
            ok = false;
        }
        document.body.removeChild(ta);
        return ok;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return "0 B";
        const units = ["B", "KB", "MB", "GB", "TB"];
        const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const val = bytes / Math.pow(1024, idx);
        return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
    }

    function formatTime(ts) {
        const d = new Date(ts);
        const pad = n => String(n).padStart(2, "0");
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function deviceIcon(peer) {
        const os = (peer.name?.os || "").toLowerCase();
        const type = (peer.name?.type || "").toLowerCase();
        if (type === "mobile" || os.includes("ios") || os.includes("android")) return "📱";
        if (type === "tablet") return "📲";
        if (os.includes("mac")) return "🖥️";
        if (os.includes("linux") || os.includes("ubuntu")) return "🐧";
        return "💻";
    }

    // 安全渲染纯文本 + http/https 自动识别链接（杜绝 XSS）
    function renderSafeLinkifiedText(container, text) {
        const urlRegex = /(https?:\/\/[^\s<>"'`]+)/g;
        let lastIndex = 0;
        let match;
        while ((match = urlRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            const rawUrl = match[0];
            const link = document.createElement("a");
            link.href = rawUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = rawUrl;
            container.appendChild(link);
            lastIndex = match.index + rawUrl.length;
        }
        if (lastIndex < text.length) {
            container.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    // ==================== WebSocket 连接与实时同步 ====================

    function setWsStatus(status) {
        els.wsStatus.className = "status-pill";
        if (status === "connected") {
            els.wsStatus.classList.add("status-connected");
            els.wsStatus.textContent = "已连接 · 局域网实时同步";
        } else if (status === "connecting") {
            els.wsStatus.classList.add("status-connecting");
            els.wsStatus.textContent = "正在连接...";
        } else {
            els.wsStatus.classList.add("status-disconnected");
            els.wsStatus.textContent = "连接断开，重连中...";
        }
    }

    function buildWsEndpoint() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = new URL(`${protocol}//${window.location.host}/`);
        if (state.peerId && state.peerIdHash) {
            url.searchParams.set("peer_id", state.peerId);
            url.searchParams.set("peer_id_hash", state.peerIdHash);
        }
        if (state.displayName) {
            url.searchParams.set("display_name", state.displayName);
        }
        if (state.roomId && state.roomId !== "global") {
            url.searchParams.set("room", state.roomId);
        }
        return url.toString();
    }

    function connectWs() {
        clearTimeout(reconnectTimer);
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        setWsStatus("connecting");
        ws = new WebSocket(buildWsEndpoint());

        ws.onopen = () => {
            setWsStatus("connected");
            loadBootstrap(state.roomId);
        };

        ws.onmessage = event => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            handleWsMessage(msg);
        };

        ws.onclose = () => {
            setWsStatus("disconnected");
            if (!manualDisconnect) {
                reconnectTimer = setTimeout(connectWs, 1500);
            }
        };

        ws.onerror = () => {
            setWsStatus("disconnected");
        };
    }

    function sendWs(payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast("当前未连接服务端，正在重连...", true);
            return false;
        }
        ws.send(JSON.stringify(payload));
        return true;
    }

    function handleWsMessage(msg) {
        switch (msg.type) {
            case "ping":
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "pong" }));
                }
                break;
            case "display-name": {
                state.peerId = msg.peerId;
                state.peerIdHash = msg.peerIdHash;
                state.displayName = msg.displayName;
                state.deviceName = msg.deviceName;
                sessionStorage.setItem("lan_peer_id", msg.peerId);
                sessionStorage.setItem("lan_peer_id_hash", msg.peerIdHash);

                const savedName = localStorage.getItem("lan_display_name");
                const confirmed = localStorage.getItem("lan_name_confirmed") === "1";

                if (msg.isHostDefaultName && !savedName) {
                    localStorage.setItem("lan_display_name", msg.displayName);
                    localStorage.setItem("lan_name_confirmed", "1");
                } else if (savedName) {
                    localStorage.setItem("lan_display_name", msg.displayName);
                }

                els.selfNameLabel.textContent = msg.displayName;
                renderPeers();

                if (!msg.isHostDefaultName && !savedName && !confirmed && !state.promptedRenameThisSession) {
                    state.promptedRenameThisSession = true;
                    els.inputDisplayName.value = "";
                    els.inputDisplayName.placeholder = `当前默认「${msg.displayName}」，建议输入电脑/设备名`;
                    if (!els.dialogRename.open) {
                        els.dialogRename.showModal();
                    }
                }
                break;
            }
            case "peers":
                state.peers = Array.isArray(msg.peers) ? msg.peers : [];
                renderPeers();
                break;
            case "peer-joined":
                if (msg.peer && !state.peers.some(p => p.id === msg.peer.id)) {
                    state.peers.push(msg.peer);
                    renderPeers();
                }
                break;
            case "peer-updated":
                if (msg.peer) {
                    const idx = state.peers.findIndex(p => p.id === msg.peer.id);
                    if (idx >= 0) state.peers[idx] = msg.peer;
                    renderPeers();
                }
                break;
            case "peer-left":
                state.peers = state.peers.filter(p => p.id !== msg.peerId);
                if (state.targetPeerId === msg.peerId) {
                    setTargetPeer(null);
                }
                renderPeers();
                break;
            case "room-created":
            case "room-joined":
                onRoomChanged(msg.roomId);
                break;
            case "room-join-error":
                showToast(msg.error || "加入房间失败", true);
                break;
            case "chat-message-added":
                if (msg.message && msg.message.roomId === state.roomId) {
                    if (!state.messages.some(m => m.id === msg.message.id)) {
                        state.messages.push(msg.message);
                        renderChatFeed(true);
                    }
                }
                break;
            case "file-added":
                if (msg.file && msg.file.roomId === state.roomId) {
                    if (!state.files.some(f => f.id === msg.file.id)) {
                        state.files.unshift(msg.file);
                        renderFilesList();
                    }
                }
                break;
            case "file-download-updated": {
                const target = state.files.find(f => f.id === msg.fileId);
                if (target) {
                    target.downloadCount = msg.downloadCount;
                    renderFilesList();
                }
                break;
            }
            case "files-deleted": {
                const delSet = new Set(msg.fileIds || []);
                state.files = state.files.filter(f => !delSet.has(f.id));
                delSet.forEach(id => state.selectedFileIds.delete(id));
                renderFilesList();
                updateFilesBatchUi();
                break;
            }
            case "messages-deleted": {
                const delSet = new Set(msg.messageIds || []);
                state.messages = state.messages.filter(m => !delSet.has(m.id));
                delSet.forEach(id => state.selectedMessageIds.delete(id));
                renderChatFeed(false);
                updateChatBatchUi();
                break;
            }
        }
    }

    async function loadBootstrap(roomId) {
        try {
            const res = await fetch(`/api/bootstrap?roomId=${encodeURIComponent(roomId)}`);
            if (!res.ok) throw new Error("Bootstrap failed");
            const data = await res.json();
            state.roomId = data.roomId || "global";
            state.hostLanUrl = data.hostLanUrl || null;
            state.messages = Array.isArray(data.messages) ? data.messages : [];
            state.files = Array.isArray(data.files) ? data.files : [];
            state.selectedMessageIds.clear();
            state.selectedFileIds.clear();
            updateRoomLabels();
            renderChatFeed(true);
            renderFilesList();
            updateChatBatchUi();
            updateFilesBatchUi();
        } catch (err) {
            console.error(err);
            showToast("加载主机历史数据失败", true);
        }
    }

    function onRoomChanged(newRoomId) {
        state.roomId = newRoomId || "global";
        setTargetPeer(null);
        syncRoomToUrl(state.roomId);
        updateRoomLabels();
        loadBootstrap(state.roomId);
        if (els.dialogRoom.open) els.dialogRoom.close();
        showToast(state.roomId === "global" ? "已进入全局局域网大厅" : `已进入房间：${state.roomId}`);
    }

    function updateRoomLabels() {
        const text = state.roomId === "global" ? "全局局域网大厅" : `房间 ${state.roomId}`;
        els.currentRoomLabel.textContent = text;
        els.modalRoomCurrent.textContent = text;
    }

    // ==================== 渲染：在线设备 ====================

    function setTargetPeer(peerId) {
        state.targetPeerId = peerId;
        if (!peerId) {
            els.composerTargetBanner.hidden = true;
        } else {
            const peer = state.peers.find(p => p.id === peerId);
            if (!peer) {
                state.targetPeerId = null;
                els.composerTargetBanner.hidden = true;
            } else {
                els.composerTargetName.textContent = peer.name.displayName;
                els.composerTargetBanner.hidden = false;
            }
        }
        renderPeers();
    }

    function renderPeers() {
        els.peersList.innerHTML = "";
        els.peersCount.textContent = String(state.peers.length + 1);

        // 本机卡片
        const selfChip = document.createElement("div");
        selfChip.className = "peer-chip self";
        selfChip.textContent = `🟢 本机: ${state.displayName || "..."}`;
        els.peersList.appendChild(selfChip);

        // 其他在线设备
        for (const peer of state.peers) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "peer-chip" + (state.targetPeerId === peer.id ? " selected" : "");
            chip.textContent = `${deviceIcon(peer)} ${peer.name.displayName}`;
            chip.addEventListener("click", () => {
                setTargetPeer(state.targetPeerId === peer.id ? null : peer.id);
            });
            els.peersList.appendChild(chip);
        }
    }

    // ==================== 渲染：多设备聊天记录（文本 + 图片直显） ====================

    function renderChatFeed(scrollToBottom) {
        els.badgeChatCount.textContent = String(state.messages.length);
        const feed = els.chatFeed;
        const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;

        feed.innerHTML = "";
        if (state.messages.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "暂无聊天记录，发送文本、粘贴网址或 Ctrl+V 粘贴/选择图片即可实时共享";
            feed.appendChild(empty);
            return;
        }

        const peerNameMap = new Map(state.peers.map(p => [p.id, `${p.name.displayName}`]));

        for (const msg of state.messages) {
            const isSelf = msg.senderId === state.peerId;
            const row = document.createElement("div");
            row.className = "msg-row" + (isSelf ? " self" : "") + (state.chatBatchMode ? " batch-mode" : "");

            if (state.chatBatchMode) {
                const chk = document.createElement("input");
                chk.type = "checkbox";
                chk.className = "msg-checkbox";
                chk.checked = state.selectedMessageIds.has(msg.id);
                chk.addEventListener("change", () => {
                    if (chk.checked) state.selectedMessageIds.add(msg.id);
                    else state.selectedMessageIds.delete(msg.id);
                    updateChatBatchUi();
                });
                row.appendChild(chk);
            }

            const bubble = document.createElement("div");
            bubble.className = "msg-bubble";

            const meta = document.createElement("div");
            meta.className = "msg-meta";

            const senderSpan = document.createElement("span");
            senderSpan.className = "msg-sender";
            senderSpan.textContent = isSelf ? `我 (${msg.senderName})` : msg.senderName;
            meta.appendChild(senderSpan);

            if (msg.targetId) {
                const tag = document.createElement("span");
                tag.className = "msg-target-tag";
                const targetLabel = msg.targetId === state.peerId ? "我" : (peerNameMap.get(msg.targetId) || "指定设备");
                tag.textContent = `私发给 ${targetLabel}`;
                meta.appendChild(tag);
            }

            const timeSpan = document.createElement("span");
            timeSpan.textContent = formatTime(msg.createdAt);
            meta.appendChild(timeSpan);
            bubble.appendChild(meta);

            if (msg.msgType === "image" && msg.fileId) {
                const imgWrap = document.createElement("div");
                imgWrap.className = "msg-image-wrap";

                const img = document.createElement("img");
                img.className = "msg-inline-img";
                img.loading = "lazy";
                img.src = `/api/files/${encodeURIComponent(msg.fileId)}/preview`;
                img.alt = msg.fileName || msg.content || "共享图片";
                img.addEventListener("click", () => openLightboxByFileId(msg.fileId));
                imgWrap.appendChild(img);

                const cap = document.createElement("div");
                cap.className = "msg-image-caption";
                const nameSpan = document.createElement("span");
                nameSpan.className = "msg-image-name";
                nameSpan.textContent = `${msg.fileName || msg.content} · ${formatBytes(msg.fileSize || 0)}`;
                cap.appendChild(nameSpan);

                const dlLink = document.createElement("a");
                dlLink.className = "msg-action-btn";
                dlLink.href = `/api/files/${encodeURIComponent(msg.fileId)}/download`;
                dlLink.textContent = "⬇ 下载原图";
                cap.appendChild(dlLink);

                imgWrap.appendChild(cap);
                bubble.appendChild(imgWrap);
            } else {
                const textDiv = document.createElement("div");
                textDiv.className = "msg-text";
                renderSafeLinkifiedText(textDiv, msg.content || "");
                bubble.appendChild(textDiv);

                const actions = document.createElement("div");
                actions.className = "msg-actions";
                const copyBtn = document.createElement("button");
                copyBtn.type = "button";
                copyBtn.className = "msg-action-btn";
                copyBtn.textContent = "📋 复制";
                copyBtn.addEventListener("click", async () => {
                    const ok = await copyText(msg.content || "");
                    showToast(ok ? "已复制到剪贴板" : "复制失败，请手动长按选择", !ok);
                });
                actions.appendChild(copyBtn);
                bubble.appendChild(actions);
            }

            row.appendChild(bubble);
            feed.appendChild(row);
        }

        if (scrollToBottom || wasNearBottom) {
            feed.scrollTop = feed.scrollHeight;
        }
    }

    function updateChatBatchUi() {
        els.chatBatchBar.hidden = !state.chatBatchMode;
        els.btnChatBatchToggle.textContent = state.chatBatchMode ? "完成" : "批量管理";
        const count = state.selectedMessageIds.size;
        els.chatSelectedCount.textContent = `已选 ${count} 条`;
        els.btnChatDeleteSelected.disabled = count === 0;
        els.chkChatSelectAll.checked = state.messages.length > 0 && count === state.messages.length;
    }

    // ==================== 渲染：主机共享文件区 ====================

    function getFilteredFiles() {
        if (state.fileFilter === "images") return state.files.filter(f => f.isImage);
        if (state.fileFilter === "files") return state.files.filter(f => !f.isImage);
        return state.files;
    }

    function renderFilesList() {
        els.badgeFilesCount.textContent = String(state.files.length);
        const visible = getFilteredFiles();
        els.filesSummary.textContent = `${visible.length} 个项目`;

        els.filesList.innerHTML = "";
        if (visible.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = state.files.length === 0 ? "当前房间暂无保存的文件" : "该分类下暂无项目";
            els.filesList.appendChild(empty);
            return;
        }

        for (const file of visible) {
            const card = document.createElement("div");
            card.className = "file-card";

            if (state.filesBatchMode) {
                const chk = document.createElement("input");
                chk.type = "checkbox";
                chk.className = "file-checkbox";
                chk.checked = state.selectedFileIds.has(file.id);
                chk.addEventListener("change", () => {
                    if (chk.checked) state.selectedFileIds.add(file.id);
                    else state.selectedFileIds.delete(file.id);
                    updateFilesBatchUi();
                });
                card.appendChild(chk);
            }

            const thumb = document.createElement("div");
            thumb.className = "file-thumb";
            if (file.isImage) {
                const img = document.createElement("img");
                img.loading = "lazy";
                img.src = `/api/files/${encodeURIComponent(file.id)}/preview`;
                img.alt = file.originalName;
                img.addEventListener("click", () => openLightboxByFileId(file.id));
                thumb.appendChild(img);
            } else {
                const ext = (file.originalName.split(".").pop() || "FILE").toUpperCase().slice(0, 4);
                thumb.textContent = ext;
            }
            card.appendChild(thumb);

            const info = document.createElement("div");
            info.className = "file-info";

            const nameDiv = document.createElement("div");
            nameDiv.className = "file-name";
            nameDiv.title = file.originalName;
            nameDiv.textContent = file.originalName;
            info.appendChild(nameDiv);

            const metaDiv = document.createElement("div");
            metaDiv.className = "file-meta";
            const items = [
                formatBytes(file.size),
                file.senderName,
                formatTime(file.createdAt),
                `下载 ${file.downloadCount || 0} 次`
            ];
            for (const txt of items) {
                const s = document.createElement("span");
                s.textContent = txt;
                metaDiv.appendChild(s);
            }
            info.appendChild(metaDiv);
            card.appendChild(info);

            const actions = document.createElement("div");
            actions.className = "file-actions";

            if (file.isImage) {
                const previewBtn = document.createElement("button");
                previewBtn.type = "button";
                previewBtn.className = "btn btn-sm btn-outline";
                previewBtn.textContent = "预览";
                previewBtn.addEventListener("click", () => openLightboxByFileId(file.id));
                actions.appendChild(previewBtn);
            }

            const dlBtn = document.createElement("a");
            dlBtn.className = "btn btn-sm btn-primary";
            dlBtn.href = `/api/files/${encodeURIComponent(file.id)}/download`;
            dlBtn.textContent = "下载";
            actions.appendChild(dlBtn);

            card.appendChild(actions);
            els.filesList.appendChild(card);
        }
    }

    function updateFilesBatchUi() {
        els.filesBatchBar.hidden = !state.filesBatchMode;
        els.btnFilesBatchToggle.textContent = state.filesBatchMode ? "完成" : "批量管理";
        const visible = getFilteredFiles();
        const count = state.selectedFileIds.size;
        els.filesSelectedCount.textContent = `已选 ${count} 项`;
        els.btnFilesDeleteSelected.disabled = count === 0;
        els.chkFilesSelectAll.checked = visible.length > 0 && visible.every(f => state.selectedFileIds.has(f.id));
    }

    // ==================== HTTP 文件上传（进度条 + 速度 + 取消） ====================

    function uploadFiles(fileList) {
        const files = Array.from(fileList || []).filter(f => f && f.size >= 0);
        if (files.length === 0) return;

        els.uploadQueue.hidden = false;

        for (const file of files) {
            uploadSingleFile(file);
        }
    }

    function uploadSingleFile(file) {
        const itemEl = document.createElement("div");
        itemEl.className = "upload-item";

        const top = document.createElement("div");
        top.className = "upload-item-top";

        const nameEl = document.createElement("span");
        nameEl.className = "upload-item-name";
        nameEl.textContent = `${file.name} (${formatBytes(file.size)})`;

        const statusEl = document.createElement("span");
        statusEl.textContent = "准备上传...";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "link-btn";
        cancelBtn.textContent = "取消";

        top.appendChild(nameEl);
        top.appendChild(statusEl);
        top.appendChild(cancelBtn);

        const track = document.createElement("div");
        track.className = "progress-track";
        const fill = document.createElement("div");
        fill.className = "progress-fill";
        track.appendChild(fill);

        itemEl.appendChild(top);
        itemEl.appendChild(track);
        els.uploadQueue.appendChild(itemEl);

        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        // 字段务必在文件流之前追加，方便 busboy 先解析出元数据
        formData.append("roomId", state.roomId || "global");
        formData.append("senderId", state.peerId || "unknown");
        formData.append("senderName", state.displayName || "局域网设备");
        if (state.targetPeerId) {
            formData.append("targetId", state.targetPeerId);
        }
        formData.append("file", file, file.name);

        const startAt = Date.now();

        xhr.upload.addEventListener("progress", e => {
            if (!e.lengthComputable) return;
            const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
            fill.style.width = `${pct}%`;
            const elapsedSec = Math.max(0.1, (Date.now() - startAt) / 1000);
            const speed = formatBytes(e.loaded / elapsedSec);
            statusEl.textContent = `${pct}% · ${speed}/s`;
        });

        xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                fill.style.width = "100%";
                statusEl.textContent = "已保存";
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.file && !state.files.some(f => f.id === data.file.id)) {
                        state.files.unshift(data.file);
                        renderFilesList();
                    }
                    if (data.message && !state.messages.some(m => m.id === data.message.id)) {
                        state.messages.push(data.message);
                        renderChatFeed(true);
                    }
                } catch (_) {
                    // ignore
                }
                setTimeout(() => {
                    itemEl.remove();
                    if (els.uploadQueue.children.length === 0) {
                        els.uploadQueue.hidden = true;
                    }
                }, 1200);
            } else {
                let errMsg = "上传失败";
                try {
                    errMsg = JSON.parse(xhr.responseText).error || errMsg;
                } catch (_) {
                    // ignore
                }
                statusEl.textContent = errMsg;
                showToast(`${file.name}: ${errMsg}`, true);
            }
        });

        xhr.addEventListener("error", () => {
            statusEl.textContent = "网络错误";
            showToast(`${file.name} 上传失败`, true);
        });

        xhr.addEventListener("abort", () => {
            itemEl.remove();
            if (els.uploadQueue.children.length === 0) {
                els.uploadQueue.hidden = true;
            }
            showToast(`已取消上传 ${file.name}`);
        });

        cancelBtn.addEventListener("click", () => xhr.abort());

        xhr.open("POST", "/api/files/upload");
        xhr.send(formData);
    }

    // ==================== Lightbox 大图预览 ====================

    function openLightboxByFileId(fileId) {
        const images = state.files.filter(f => f.isImage);
        if (images.length === 0) return;
        const idx = Math.max(0, images.findIndex(f => f.id === fileId));
        state.lightboxImages = images;
        state.lightboxIndex = idx;
        renderLightbox();
        if (!els.dialogLightbox.open) {
            els.dialogLightbox.showModal();
        }
    }

    function renderLightbox() {
        const imgFile = state.lightboxImages[state.lightboxIndex];
        if (!imgFile) return;
        els.lightboxImg.src = `/api/files/${encodeURIComponent(imgFile.id)}/preview`;
        els.lightboxCaption.textContent = `${imgFile.originalName} (${formatBytes(imgFile.size)}) · ${state.lightboxIndex + 1}/${state.lightboxImages.length}`;
        els.btnLightboxDownload.href = `/api/files/${encodeURIComponent(imgFile.id)}/download`;
        els.btnLightboxPrev.disabled = state.lightboxImages.length <= 1;
        els.btnLightboxNext.disabled = state.lightboxImages.length <= 1;
    }

    // ==================== 二维码弹窗 ====================

    function openQrDialog() {
        const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
        let targetUrl = window.location.href;

        if (isLocalhost && state.hostLanUrl) {
            const url = new URL(state.hostLanUrl);
            if (state.roomId && state.roomId !== "global") {
                url.searchParams.set("room", state.roomId);
            }
            targetUrl = url.toString();
            els.qrHintText.textContent = "已自动替换为宿主机局域网地址，同一 Wi-Fi 下手机可直接扫码打开";
        } else if (isLocalhost) {
            els.qrHintText.textContent = "当前使用的是 localhost，请改用主机局域网 IP（如 http://192.168.x.x:9010）访问后再扫码";
        } else {
            els.qrHintText.textContent = "同一局域网下的手机/平板使用相机或浏览器扫码即可打开";
        }

        els.qrUrlText.textContent = targetUrl;
        els.qrContainer.innerHTML = "";

        if (typeof QRCode === "function") {
            const svg = new QRCode({
                content: targetUrl,
                padding: 2,
                width: 200,
                height: 200,
                color: "#000000",
                background: "#ffffff",
                ecl: "M"
            }).svg({ container: "svg-viewbox" });
            els.qrContainer.innerHTML = svg;
        } else {
            els.qrContainer.textContent = targetUrl;
        }

        els.dialogQr.showModal();
    }

    // ==================== 事件绑定 ====================

    function bindEvents() {
        // 移动端 Tab 切换
        document.querySelectorAll(".mobile-tab").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".mobile-tab").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                const tab = btn.dataset.tab;
                els.panelChat.classList.toggle("active-mobile-panel", tab === "chat");
                els.panelFiles.classList.toggle("active-mobile-panel", tab === "files");
            });
        });

        // 发送文本消息
        els.chatForm.addEventListener("submit", e => {
            e.preventDefault();
            const text = els.chatInput.value.trim();
            if (!text) return;
            const sent = sendWs({
                type: "chat-text",
                content: text,
                targetId: state.targetPeerId || null
            });
            if (sent) {
                els.chatInput.value = "";
            }
        });

        els.chatInput.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                els.chatForm.requestSubmit();
            }
        });

        // 聊天框直接 Ctrl+V 粘贴截图/图片上传
        els.chatInput.addEventListener("paste", e => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const pastedFiles = [];
            for (const item of items) {
                if (item.kind === "file") {
                    const f = item.getAsFile();
                    if (f) pastedFiles.push(f);
                }
            }
            if (pastedFiles.length > 0) {
                e.preventDefault();
                uploadFiles(pastedFiles);
                showToast(`已捕获剪贴板中的 ${pastedFiles.length} 个文件，正在上传...`);
            }
        });

        els.btnClearTarget.addEventListener("click", () => setTargetPeer(null));

        // 选图片 / 选文件
        els.btnPickImage.addEventListener("click", () => els.inputImageFile.click());
        els.inputImageFile.addEventListener("change", () => {
            uploadFiles(els.inputImageFile.files);
            els.inputImageFile.value = "";
        });

        els.btnPickFileChat.addEventListener("click", () => els.inputAnyFile.click());
        els.btnPickFiles.addEventListener("click", () => els.inputAnyFile.click());
        els.inputAnyFile.addEventListener("change", () => {
            uploadFiles(els.inputAnyFile.files);
            els.inputAnyFile.value = "";
        });

        // 拖拽上传（局部 + 全局）
        let dragDepth = 0;
        window.addEventListener("dragenter", e => {
            if (!e.dataTransfer?.types?.includes("Files")) return;
            e.preventDefault();
            dragDepth += 1;
            els.globalDropOverlay.hidden = false;
        });
        window.addEventListener("dragover", e => {
            if (!e.dataTransfer?.types?.includes("Files")) return;
            e.preventDefault();
        });
        window.addEventListener("dragleave", e => {
            if (!e.dataTransfer?.types?.includes("Files")) return;
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) {
                els.globalDropOverlay.hidden = true;
            }
        });
        window.addEventListener("drop", e => {
            if (!e.dataTransfer?.files?.length) {
                dragDepth = 0;
                els.globalDropOverlay.hidden = true;
                return;
            }
            e.preventDefault();
            dragDepth = 0;
            els.globalDropOverlay.hidden = true;
            uploadFiles(e.dataTransfer.files);
        });

        // 文件分类筛选
        document.querySelectorAll(".filter-pill").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".filter-pill").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                state.fileFilter = btn.dataset.filter || "all";
                renderFilesList();
                updateFilesBatchUi();
            });
        });

        // 聊天批量管理
        els.btnChatBatchToggle.addEventListener("click", () => {
            state.chatBatchMode = !state.chatBatchMode;
            if (!state.chatBatchMode) state.selectedMessageIds.clear();
            updateChatBatchUi();
            renderChatFeed(false);
        });
        els.btnChatBatchCancel.addEventListener("click", () => {
            state.chatBatchMode = false;
            state.selectedMessageIds.clear();
            updateChatBatchUi();
            renderChatFeed(false);
        });
        els.chkChatSelectAll.addEventListener("change", () => {
            if (els.chkChatSelectAll.checked) {
                state.messages.forEach(m => state.selectedMessageIds.add(m.id));
            } else {
                state.selectedMessageIds.clear();
            }
            updateChatBatchUi();
            renderChatFeed(false);
        });
        els.btnChatDeleteSelected.addEventListener("click", async () => {
            const ids = Array.from(state.selectedMessageIds);
            if (ids.length === 0) return;
            if (!confirm(`确定删除选中的 ${ids.length} 条聊天记录吗？（仅移除消息记录；若需删除图片原文件请在文件区删除）`)) return;
            try {
                const res = await fetch("/api/messages/batch-delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids, roomId: state.roomId })
                });
                if (!res.ok) throw new Error();
                state.selectedMessageIds.clear();
                state.chatBatchMode = false;
                updateChatBatchUi();
                showToast(`已删除 ${ids.length} 条聊天记录`);
            } catch (_) {
                showToast("批量删除聊天记录失败", true);
            }
        });

        // 文件批量管理
        els.btnFilesBatchToggle.addEventListener("click", () => {
            state.filesBatchMode = !state.filesBatchMode;
            if (!state.filesBatchMode) state.selectedFileIds.clear();
            updateFilesBatchUi();
            renderFilesList();
        });
        els.btnFilesBatchCancel.addEventListener("click", () => {
            state.filesBatchMode = false;
            state.selectedFileIds.clear();
            updateFilesBatchUi();
            renderFilesList();
        });
        els.chkFilesSelectAll.addEventListener("change", () => {
            const visible = getFilteredFiles();
            if (els.chkFilesSelectAll.checked) {
                visible.forEach(f => state.selectedFileIds.add(f.id));
            } else {
                visible.forEach(f => state.selectedFileIds.delete(f.id));
            }
            updateFilesBatchUi();
            renderFilesList();
        });
        els.btnFilesDeleteSelected.addEventListener("click", async () => {
            const ids = Array.from(state.selectedFileIds);
            if (ids.length === 0) return;
            if (!confirm(`确定从主机磁盘永久删除选中的 ${ids.length} 个文件吗？此操作不可恢复。`)) return;
            try {
                const res = await fetch("/api/files/batch-delete", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ids, roomId: state.roomId })
                });
                if (!res.ok) throw new Error();
                state.selectedFileIds.clear();
                state.filesBatchMode = false;
                updateFilesBatchUi();
                showToast(`已永久删除 ${ids.length} 个文件`);
            } catch (_) {
                showToast("批量删除文件失败", true);
            }
        });

        // 房间弹窗
        els.btnRoom.addEventListener("click", () => {
            els.inputRoomCode.value = state.roomId === "global" ? "" : state.roomId;
            els.dialogRoom.showModal();
        });
        els.btnCreateRoom.addEventListener("click", () => sendWs({ type: "create-room" }));
        els.formJoinRoom.addEventListener("submit", e => {
            e.preventDefault();
            const code = els.inputRoomCode.value.trim();
            if (!code) {
                sendWs({ type: "leave-room" });
                return;
            }
            sendWs({ type: "join-room", roomId: code });
        });
        els.btnLeaveRoom.addEventListener("click", () => sendWs({ type: "leave-room" }));

        // 二维码弹窗
        els.btnQr.addEventListener("click", openQrDialog);
        els.btnCopyQrUrl.addEventListener("click", async () => {
            const ok = await copyText(els.qrUrlText.textContent || "");
            showToast(ok ? "访问链接已复制" : "复制失败", !ok);
        });

        // 改名弹窗
        els.btnRename.addEventListener("click", () => {
            els.inputDisplayName.value = state.displayName || "";
            els.dialogRename.showModal();
        });
        els.dialogRename.addEventListener("close", () => {
            localStorage.setItem("lan_name_confirmed", "1");
        });
        els.formRename.addEventListener("submit", e => {
            e.preventDefault();
            const nextName = els.inputDisplayName.value.trim();
            if (!nextName) return;
            localStorage.setItem("lan_display_name", nextName);
            localStorage.setItem("lan_name_confirmed", "1");
            if (sendWs({ type: "update-display-name", displayName: nextName })) {
                els.dialogRename.close();
                showToast("设备名称已保存");
            }
        });

        // Lightbox 翻页
        els.btnLightboxPrev.addEventListener("click", () => {
            if (state.lightboxImages.length <= 1) return;
            state.lightboxIndex = (state.lightboxIndex - 1 + state.lightboxImages.length) % state.lightboxImages.length;
            renderLightbox();
        });
        els.btnLightboxNext.addEventListener("click", () => {
            if (state.lightboxImages.length <= 1) return;
            state.lightboxIndex = (state.lightboxIndex + 1) % state.lightboxImages.length;
            renderLightbox();
        });

        // 通用关闭弹窗按钮
        document.querySelectorAll("[data-close-dialog]").forEach(btn => {
            btn.addEventListener("click", () => {
                const dialog = $(btn.dataset.closeDialog);
                if (dialog?.open) dialog.close();
            });
        });

        window.addEventListener("beforeunload", () => {
            manualDisconnect = true;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "disconnect" }));
                ws.close();
            }
        });
    }

    initTheme();
    bindEvents();
    updateRoomLabels();
    connectWs();
})();

'use strict';

const SESSION_STATUS = {
    WAITING: 'WAITING',
    CONNECTED: 'CONNECTED',
    QUESTION_ACTIVE: 'QUESTION_ACTIVE',
    QUESTION_LOCKED: 'QUESTION_LOCKED',
    QUESTION_RESULT: 'QUESTION_RESULT',
    COMPLETED: 'COMPLETED'
};

const appState = {
    sessionId: null,
    session: null,
    soundEnabled: true,
    cameraReady: false
};

function $(sel) { return document.querySelector(sel); }
function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(msg, ms = 2500) {
    const c = $('#toast-container');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), ms);
}

function showModal(html) {
    $('#modal-box').innerHTML = html;
    $('#modal-overlay').classList.remove('hidden');
}

function hideModal() {
    $('#modal-overlay').classList.add('hidden');
    $('#modal-box').innerHTML = '';
}

function showView(id) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${id}`)?.classList.add('active');
}

function $$(sel) { return document.querySelectorAll(sel); }

function getShortSessionCode(sessionId) {
    if (!sessionId) return '';
    return sessionId.replace('SESSION-', 'S').slice(0, 8).toUpperCase();
}

function playSound(type) {
    if (!appState.soundEnabled) return;
    try {
        const ctx = playSound._ctx || (playSound._ctx = new (window.AudioContext || window.webkitAudioContext)());
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const freqs = { scan: 880, lock: 440, next: 550 };
        osc.frequency.value = freqs[type] || 500;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
    } catch (_) {}
}

/* ===== SYNC (scanner = client) ===== */
const SyncEngine = {
    peer: null,
    conn: null,
    onMessage: null,
    reconnectTimer: null,
    statePollTimer: null,

    connectScanner(sessionId) {
        return new Promise((resolve) => {
            const hostId = 'pm-' + sessionId;
            try {
                this.peer?.destroy();
                this.peer = new Peer(undefined, {
                    debug: 1,
                    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
                });
                this.peer.on('open', () => {
                    const conn = this.peer.connect(hostId, { reliable: true });
                    let settled = false;
                    const done = (ok) => {
                        if (settled) return;
                        settled = true;
                        resolve(ok);
                    };
                    conn.on('data', (data) => this._handle(data));
                    conn.on('open', () => {
                        this.conn = conn;
                        done(true);
                    });
                    conn.on('error', () => done(false));
                    setTimeout(() => done(false), 10000);
                });
                this.peer.on('error', () => resolve(false));
            } catch {
                resolve(false);
            }
        });
    },

    _handle(msg) {
        if (this.onMessage) this.onMessage(msg);
    },

    send(msg) {
        if (this.conn?.open) this.conn.send(msg);
    },

    destroy() {
        clearInterval(this.reconnectTimer);
        clearInterval(this.statePollTimer);
        this.conn?.close();
        this.peer?.destroy();
        this.conn = null;
        this.peer = null;
    },

    requestState() {
        this.send({ type: 'REQUEST_STATE' });
    }
};

/* ===== SESSION HELPERS ===== */
function getCurrentQuestion(session) {
    return session?.questions?.[session.currentQuestionIndex] || null;
}

function getAnswersForQuestion(session, questionId) {
    return (session.answers || []).filter(a => a.questionId === questionId);
}

function getAnswerKey(session, questionId, studentId) {
    return session.answers.findIndex(
        a => a.sessionId === session.id && a.questionId === questionId && a.studentId === studentId
    );
}

function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function recordAnswer(session, studentId, cardId, answer) {
    const q = getCurrentQuestion(session);
    if (!q || session.status === SESSION_STATUS.QUESTION_LOCKED ||
        session.status === SESSION_STATUS.QUESTION_RESULT) return { ok: false };

    if (!session.answers) session.answers = [];

    const existingIdx = getAnswerKey(session, q.id, studentId);
    const record = {
        id: uid('ans'),
        sessionId: session.id,
        questionId: q.id,
        studentId,
        cardId,
        answer,
        isCorrect: null,
        submittedAt: Date.now()
    };

    let updated = false;
    if (existingIdx >= 0) {
        session.answers[existingIdx] = { ...session.answers[existingIdx], answer, submittedAt: Date.now() };
        updated = true;
    } else {
        session.answers.push(record);
    }
    return { ok: true, updated };
}

function getQuestionStats(session, questionId) {
    const ans = getAnswersForQuestion(session, questionId);
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    ans.forEach(a => {
        if (a.answer && counts[a.answer] !== undefined) counts[a.answer]++;
    });
    return { counts, answers: ans };
}

function getSessionSnapshot() {
    const s = appState.session;
    if (!s) return null;
    return JSON.parse(JSON.stringify({
        id: s.id, classId: s.classId, questionSetId: s.questionSetId,
        className: s.className, qsetName: s.qsetName,
        students: s.students, questions: s.questions,
        currentQuestionIndex: s.currentQuestionIndex,
        status: s.status, answers: s.answers,
        scannerConnected: s.scannerConnected, startedAt: s.startedAt
    }));
}

function mergeSession(data) {
    if (!data) return;
    if (!appState.session) {
        appState.session = data;
    } else {
        Object.assign(appState.session, data);
    }
    onSessionUpdated();
}

function onSessionUpdated() {
    const s = appState.session;
    if (!s) return;

    if (s.status === SESSION_STATUS.COMPLETED) {
        CardScanner.stop();
        clearInterval(SyncEngine.statePollTimer);
        showView('ended');
        return;
    }

    if (s.questions?.length && s.students?.length) {
        clearInterval(SyncEngine.statePollTimer);
        if (!appState.cameraReady) startCamera();
        else renderScanner();
        showView('scanner');
    } else {
        $('#wait-status').textContent = 'Đã kết nối — đang lấy danh sách lớp và câu hỏi...';
    }
}

function handleSyncMessage(msg) {
    if (!msg?.type) return;

    switch (msg.type) {
        case 'STATE_SYNC':
        case 'SESSION_CREATED':
        case 'QUESTION_CHANGED':
        case 'QUESTION_RESULT':
        case 'NEXT_QUESTION':
        case 'QUESTION_LOCKED':
        case 'ANSWER_SCANNED':
        case 'ANSWER_UPDATED':
            if (msg.session) mergeSession(msg.session);
            break;
        case 'SESSION_COMPLETED':
            if (msg.session) mergeSession(msg.session);
            else if (appState.session) {
                appState.session.status = SESSION_STATUS.COMPLETED;
                onSessionUpdated();
            }
            break;
    }
}

/* ===== MARKER (Plickers-style) — nhận diện thẻ số + hướng A/B/C/D ===== */
const MarkerUtil = {
    ORIENT: ['A', 'D', 'C', 'B'],

    getGrid(cardNumber) {
        const grid = Array.from({ length: 7 }, () => Array(7).fill(0));
        for (let i = 0; i < 7; i++) {
            grid[0][i] = grid[6][i] = grid[i][0] = grid[i][6] = 1;
        }
        let seed = cardNumber * 7919 + 104729;
        for (let r = 1; r < 6; r++) {
            for (let c = 1; c < 6; c++) {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                grid[r][c] = (seed % 3) !== 0 ? 1 : 0;
            }
        }
        grid[1][1] = grid[1][5] = grid[5][1] = 1;
        grid[5][5] = 0;
        return grid;
    },

    rotateGrid(grid, times) {
        let g = grid.map(row => [...row]);
        for (let t = 0; t < times; t++) {
            const n = g.length;
            const rotated = Array.from({ length: n }, () => Array(n).fill(0));
            for (let r = 0; r < n; r++) {
                for (let c = 0; c < n; c++) {
                    rotated[c][n - 1 - r] = g[r][c];
                }
            }
            g = rotated;
        }
        return g;
    },

    invertGrid(grid) {
        return grid.map(row => row.map(v => 1 - v));
    },

    gridMatch(a, b, skipCenter = true) {
        let d = 0, n = 0, borderD = 0, borderN = 0;
        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
                if (skipCenter && r >= 2 && r <= 4 && c >= 2 && c <= 4) continue;
                n++;
                if (a[r][c] !== b[r][c]) d++;
                if (isBorder) {
                    borderN++;
                    if (a[r][c] !== b[r][c]) borderD++;
                }
            }
        }
        return {
            d,
            n,
            score: n ? 1 - d / n : 0,
            borderScore: borderN ? 1 - borderD / borderN : 0
        };
    },

    sampleGrid(imageData, width, height, cx, cy, boxSize) {
        const cell = boxSize / 7;
        const lums = Array.from({ length: 7 }, () => Array(7).fill(128));

        for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 7; c++) {
                const x0 = Math.floor(cx - boxSize / 2 + c * cell + cell * 0.15);
                const y0 = Math.floor(cy - boxSize / 2 + r * cell + cell * 0.15);
                const x1 = Math.floor(cx - boxSize / 2 + (c + 1) * cell - cell * 0.15);
                const y1 = Math.floor(cy - boxSize / 2 + (r + 1) * cell - cell * 0.15);
                let sum = 0, count = 0;
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        const i = (y * width + x) * 4;
                        sum += 0.299 * imageData[i] + 0.587 * imageData[i + 1] + 0.114 * imageData[i + 2];
                        count++;
                    }
                }
                lums[r][c] = count ? sum / count : 128;
            }
        }

        const borderVals = [];
        for (let i = 0; i < 7; i++) {
            borderVals.push(lums[0][i], lums[6][i], lums[i][0], lums[i][6]);
        }
        borderVals.sort((a, b) => a - b);
        const mid = borderVals[Math.floor(borderVals.length / 2)];
        const innerVals = [];
        for (let r = 1; r < 6; r++) {
            for (let c = 1; c < 6; c++) innerVals.push(lums[r][c]);
        }
        innerVals.sort((a, b) => a - b);
        const innerMid = innerVals[Math.floor(innerVals.length / 2)];
        const threshold = (mid + innerMid) / 2;

        return lums.map(row => row.map(v => (v < threshold ? 1 : 0)));
    },

    decode(imageData, width, height, students) {
        const all = this.decodeAll(imageData, width, height, students);
        if (!all.length) return null;
        return all.reduce((a, b) => (a.rank > b.rank ? a : b));
    },

    decodeAll(imageData, width, height, students) {
        if (!students?.length) return [];

        let data = imageData;
        let w = width;
        let h = height;
        const maxW = 640;
        if (width > maxW) {
            const scaled = this._downscale(imageData, width, height, maxW);
            data = scaled.data;
            w = scaled.width;
            h = scaled.height;
        }

        const patterns = students.map(st => ({
            student: st,
            grid: this.getGrid(st.cardNumber)
        }));

        const byCard = new Map();
        const minSide = Math.min(w, h);
        const sizeRatios = [0.08, 0.11, 0.14, 0.18, 0.22, 0.28, 0.35, 0.42];
        const positions = [];
        for (let gy = 0; gy < 5; gy++) {
            for (let gx = 0; gx < 5; gx++) {
                positions.push([
                    w * (0.08 + gx * 0.21),
                    h * (0.1 + gy * 0.18)
                ]);
            }
        }

        for (const [cx, cy] of positions) {
            for (const ratio of sizeRatios) {
                const boxSize = minSide * ratio;
                const sampled = this.sampleGrid(data, w, h, cx, cy, boxSize);

                for (const polar of [sampled, this.invertGrid(sampled)]) {
                    for (let rot = 0; rot < 4; rot++) {
                        const rotated = this.rotateGrid(polar, rot);
                        for (const p of patterns) {
                            const m = this.gridMatch(rotated, p.grid, true);
                            const ok = m.borderScore >= 0.68 && (m.score >= 0.72 || m.d <= 13);
                            if (!ok) continue;
                            const rank = m.score * 100 + m.borderScore * 10 - m.d * 0.01;
                            const hit = {
                                rank,
                                dist: m.d,
                                score: m.score,
                                cardId: p.student.cardId,
                                cardNumber: p.student.cardNumber,
                                student: p.student,
                                orientation: this.ORIENT[rot],
                                cx, cy
                            };
                            const prev = byCard.get(p.student.cardId);
                            if (!prev || hit.rank > prev.rank) byCard.set(p.student.cardId, hit);
                        }
                    }
                }
            }
        }
        return Array.from(byCard.values());
    },

    _downscale(src, sw, sh, maxW) {
        const scale = maxW / sw;
        const dw = Math.floor(sw * scale);
        const dh = Math.floor(sh * scale);
        const out = new Uint8ClampedArray(dw * dh * 4);
        for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
                const sx = Math.min(sw - 1, Math.floor(x / scale));
                const sy = Math.min(sh - 1, Math.floor(y / scale));
                const si = (sy * sw + sx) * 4;
                const di = (y * dw + x) * 4;
                out[di] = src[si];
                out[di + 1] = src[si + 1];
                out[di + 2] = src[si + 2];
                out[di + 3] = 255;
            }
        }
        return { data: out, width: dw, height: dh };
    }
};

/* ===== CARD SCANNER ===== */
const CardScanner = {
    stream: null,
    rafId: null,
    lastScan: {},
    frameCount: 0,

    async start(videoEl, canvasEl) {
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
            });
            videoEl.srcObject = this.stream;
            await videoEl.play();
            this._loop(videoEl, canvasEl);
            appState.cameraReady = true;
            return true;
        } catch (e) {
            showToast('Không mở được camera: ' + e.message);
            return false;
        }
    },

    stop() {
        cancelAnimationFrame(this.rafId);
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.lastScan = {};
        this.frameCount = 0;
        appState.cameraReady = false;
    },

    _loop(video, canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = () => {
            if (!this.stream) return;
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0);
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                this.frameCount++;
                this._scanFrame(img);
            }
            this.rafId = requestAnimationFrame(tick);
        };
        tick();
    },

    _scanFrame(img) {
        const students = appState.session?.students || [];

        if (!students.length) {
            if (this.frameCount % 45 === 0) {
                $('#scan-hint')?.classList.remove('hidden');
                $('#scan-hint').textContent = 'Chưa có danh sách học sinh — mở phiên trên máy tính trước';
            }
            return;
        }

        // 1) jsQR — QR ở giữa thẻ in PDF
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) {
            this._processQr(code);
            return;
        }

        // 2) Marker grid — quét full khung, nhiều thẻ cùng lúc
        if (this.frameCount % 2 === 0) {
            const hits = MarkerUtil.decodeAll(img.data, img.width, img.height, students);
            for (const hit of hits) {
                this._processHit(hit.cardId, hit.orientation, hit.student);
            }
            if (hits.length) return;
        }

        if (this.frameCount % 20 === 0) {
            $('#scan-hint')?.classList.remove('hidden');
            $('#scan-hint').textContent = 'Giơ thẻ hướng đáp án lên trên — quét được nhiều em cùng lúc';
        }
    },

    _processQr(code) {
        const data = code.data.trim();
        let cardId = null;
        if (data.startsWith('CARD-')) cardId = data.split('|')[0];
        else {
            try {
                const j = JSON.parse(data);
                cardId = j.card || j.cardId;
            } catch (_) {}
        }
        if (!cardId) return;
        $('#scan-hint')?.classList.add('hidden');
        const orientation = this._getOrientation(code.location);
        this._processHit(cardId, orientation);
    },

    _processHit(cardId, orientation, knownStudent = null) {
        const key = cardId + orientation;
        const now = Date.now();
        if (this.lastScan[key] && now - this.lastScan[key] < 900) return;
        this.lastScan[key] = now;
        $('#scan-hint')?.classList.add('hidden');
        onCardScanned(cardId, orientation, knownStudent);
    },

    _getOrientation(loc) {
        const dx = loc.topRightCorner.x - loc.topLeftCorner.x;
        const dy = loc.topRightCorner.y - loc.topLeftCorner.y;
        let angle = Math.atan2(dy, dx) * 180 / Math.PI;
        angle = ((angle % 360) + 360) % 360;
        if (angle >= 315 || angle < 45) return 'A';
        if (angle >= 45 && angle < 135) return 'B';
        if (angle >= 135 && angle < 225) return 'C';
        return 'D';
    }
};

function onCardScanned(cardId, orientation, knownStudent = null) {
    const s = appState.session;
    if (!s?.students?.length) return;
    if (s.status === SESSION_STATUS.QUESTION_LOCKED || s.status === SESSION_STATUS.QUESTION_RESULT) return;

    const student = knownStudent || s.students.find(st => st.cardId === cardId);
    if (!student) {
        showScanToast('Không tìm thấy học sinh cho thẻ này', false);
        return;
    }

    const result = recordAnswer(s, student.id, cardId, orientation);
    if (!result.ok) return;

    const eventType = result.updated ? 'ANSWER_UPDATED' : 'ANSWER_SCANNED';
    const q = getCurrentQuestion(s);
    SyncEngine.send({
        type: eventType,
        studentId: student.id,
        cardId,
        answer: orientation,
        questionId: q?.id,
        session: getSessionSnapshot()
    });

    const tag = $('#scan-student-tag');
    tag.textContent = student.name;
    tag.classList.remove('hidden');
    clearTimeout(showScanToast._tagT);
    showScanToast._tagT = setTimeout(() => tag.classList.add('hidden'), 2000);

    showScanToast(
        result.updated
            ? `↻ ${student.name}\nĐã cập nhật: ${orientation}`
            : `✓ ${student.name}\nThẻ ${String(student.cardNumber).padStart(2, '0')}\nChọn: ${orientation}`,
        !result.updated
    );
    playSound('scan');
    renderScanner();
}

function showScanToast(text, success = true) {
    const el = $('#scan-toast');
    el.textContent = text;
    el.classList.remove('hidden', 'update');
    if (!success) el.classList.add('update');
    clearTimeout(showScanToast._t);
    showScanToast._t = setTimeout(() => el.classList.add('hidden'), 1200);
}

function renderScanner() {
    const s = appState.session;
    if (!s?.questions?.length) return;

    const q = getCurrentQuestion(s);
    const answered = getAnswersForQuestion(s, q?.id).filter(a => a.answer);
    const isResult = s.status === SESSION_STATUS.QUESTION_RESULT;

    $('#scan-q-pill').textContent = `📋 Câu ${s.currentQuestionIndex + 1}/${s.questions.length}`;
    $('#scan-count-pill').textContent = `✓ ${answered.length}/${s.students.length}`;
    $('#scan-answered-count').textContent = `${answered.length}/${s.students.length} đã trả lời`;

    $('#scanner-active').classList.toggle('hidden', isResult);
    $('#scanner-result').classList.toggle('hidden', !isResult);

    $('#scanner-answered-list').innerHTML = s.students.map(st => {
        const a = s.answers.find(x => x.questionId === q?.id && x.studentId === st.id);
        const done = a?.answer;
        return `<span class="answered-chip ${done ? '' : 'pending'}">
            <span>${esc(st.name)}</span>
            <strong>${done || '—'}</strong>
        </span>`;
    }).join('');

    if (isResult && q) {
        const stats = getQuestionStats(s, q.id);
        $('#scan-result-header').innerHTML = `
            <p>📝 Câu ${s.currentQuestionIndex + 1} / ${s.questions.length}</p>
            <p>✓ ${answered.length} / ${s.students.length} đã trả lời</p>
            <p style="color:var(--green);font-weight:700;">✓ Đáp án đúng: ${q.correctAnswer}</p>`;
        const max = Math.max(1, ...['A', 'B', 'C', 'D'].map(id => stats.counts[id] || 0));
        $('#scan-result-bars').innerHTML = ['A', 'B', 'C', 'D'].map(id => {
            const n = stats.counts[id] || 0;
            return `<div class="result-bar-row"><span class="result-bar-label">${id}</span>
                <div class="result-bar-track"><div class="result-bar-fill" style="width:${Math.round(n / max * 100)}%"></div></div>
                <span>${n}</span></div>`;
        }).join('');
    }
}

async function startCamera() {
    const video = $('#scanner-video');
    const canvas = $('#scanner-canvas');
    await CardScanner.start(video, canvas);
    renderScanner();
}

function confirmLockQuestion() {
    const s = appState.session;
    const q = getCurrentQuestion(s);
    if (!q) return;
    const answered = getAnswersForQuestion(s, q.id).filter(a => a.answer).length;
    const missing = s.students.length - answered;

    if (missing > 0) {
        showModal(`
            <h3>⚠ Còn ${missing} học sinh chưa trả lời</h3>
            <p>Bạn vẫn muốn chốt câu?</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="mc-cancel">Quay lại</button>
                <button class="btn btn-primary" id="mc-ok">Chốt câu</button>
            </div>
        `);
        $('#mc-cancel').onclick = hideModal;
        $('#mc-ok').onclick = () => { hideModal(); doLockQuestion(); };
    } else {
        doLockQuestion();
    }
}

function doLockQuestion() {
    SyncEngine.send({ type: 'LOCK_QUESTION' });
    setTimeout(() => SyncEngine.send({ type: 'REQUEST_STATE' }), 400);
    playSound('lock');
}

function showChoosersModal() {
    const s = appState.session;
    const q = getCurrentQuestion(s);
    const stats = getQuestionStats(s, q.id);
    const byAnswer = { A: [], B: [], C: [], D: [] };

    stats.answers.forEach(a => {
        if (a.answer && byAnswer[a.answer]) {
            const st = s.students.find(x => x.id === a.studentId);
            if (st) byAnswer[a.answer].push(st.name);
        }
    });

    showModal(`
        <h3>👁 Người chọn — Câu ${s.currentQuestionIndex + 1}</h3>
        <div class="choosers-list">
            ${['A', 'B', 'C', 'D'].map(id => `
                <div class="chooser-group ${id === q.correctAnswer ? 'correct' : ''}">
                    <h4>${id}${id === q.correctAnswer ? ' ✓' : ''}</h4>
                    <ul>${(byAnswer[id].length ? byAnswer[id] : ['—']).map(n => `<li>${esc(n)}</li>`).join('')}</ul>
                </div>
            `).join('')}
        </div>
        <div class="modal-actions"><button class="btn btn-primary" id="mc-close">Đóng</button></div>
    `);
    $('#mc-close').onclick = hideModal;
}

function confirmEndSession() {
    const s = appState.session;
    showModal(`
        <h3>🛑 Kết thúc phiên?</h3>
        <p>${s?.students?.length || 0} học sinh</p>
        <div class="modal-actions">
            <button class="btn btn-secondary" id="me-cancel">Hủy</button>
            <button class="btn btn-primary" id="me-ok" style="background:#ef4444;">Kết thúc</button>
        </div>
    `);
    $('#me-cancel').onclick = hideModal;
    $('#me-ok').onclick = () => { hideModal(); SyncEngine.send({ type: 'END_SESSION' }); };
}

function startReconnectLoop(sessionId) {
    SyncEngine.reconnectTimer = setInterval(async () => {
        if (!SyncEngine.conn?.open) {
            $('#scanner-reconnect')?.classList.remove('hidden');
            const ok = await SyncEngine.connectScanner(sessionId);
            if (ok) {
                $('#scanner-reconnect')?.classList.add('hidden');
                notifyHostConnected();
                startStatePoll();
                $('#wait-status').textContent = 'Đã kết nối lại';
            }
        }
    }, 5000);
}

function startStatePoll() {
    clearInterval(SyncEngine.statePollTimer);
    SyncEngine.statePollTimer = setInterval(() => {
        if (appState.session?.questions?.length && appState.session?.students?.length) {
            clearInterval(SyncEngine.statePollTimer);
            onSessionUpdated();
            return;
        }
        if (SyncEngine.conn?.open) SyncEngine.requestState();
    }, 2000);
}

function notifyHostConnected() {
    SyncEngine.send({ type: 'SCANNER_CONNECTED', from: 'scanner' });
    SyncEngine.requestState();
}

async function init(sessionId) {
    appState.sessionId = sessionId;
    appState.session = { id: sessionId, status: SESSION_STATUS.WAITING, students: [], questions: [], answers: [] };

    $('#wait-session').textContent = getShortSessionCode(sessionId);
    showView('waiting');

    SyncEngine.onMessage = handleSyncMessage;

    const connected = await SyncEngine.connectScanner(sessionId);
    if (connected) {
        notifyHostConnected();
        $('#wait-status').textContent = 'Đã kết nối — đang lấy dữ liệu từ máy chiếu...';
        startStatePoll();
    } else {
        $('#wait-status').textContent = 'Chưa kết nối — mở phiên trên máy tính trước, rồi quét lại QR';
        showToast('Đang thử kết nối lại...');
    }

    startReconnectLoop(sessionId);
}

function bindEvents() {
    $('#btn-lock-question')?.addEventListener('click', confirmLockQuestion);
    $('#btn-end-session-top')?.addEventListener('click', confirmEndSession);
    $('#btn-toggle-drawer')?.addEventListener('click', () => $('#scanner-drawer')?.classList.toggle('hidden'));
    $('#btn-next-q-result')?.addEventListener('click', () => {
        SyncEngine.send({ type: 'NEXT_QUESTION' });
        setTimeout(() => SyncEngine.send({ type: 'REQUEST_STATE' }), 400);
        playSound('next');
    });
    $('#btn-show-choosers')?.addEventListener('click', showChoosersModal);
    $('#modal-overlay')?.addEventListener('click', e => {
        if (e.target === $('#modal-overlay')) hideModal();
    });
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    if (!sessionId) {
        showView('no-session');
        return;
    }
    init(sessionId);
});

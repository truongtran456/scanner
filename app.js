'use strict';

/* ============================================================
   RUNG CHUÔNG VÀNG v3 — Scanner / Student App
   Hỗ trợ 2 luồng:
   1. Chế độ QUÉT THẺ (paper): kết nối PeerJS → camera scan markers
   2. Chế độ PHÒNG MÁY (online): vào phòng → chọn tên → bấm A/B/C/D
   ============================================================ */

const SESSION_STATUS = {
    WAITING: 'WAITING', CONNECTED: 'CONNECTED',
    QUESTION_ACTIVE: 'QUESTION_ACTIVE', QUESTION_LOCKED: 'QUESTION_LOCKED',
    QUESTION_RESULT: 'QUESTION_RESULT', COMPLETED: 'COMPLETED', RANKING: 'RANKING'
};

const appState = {
    sessionId: null,
    roomCode: null,
    session: null,
    myStudentId: null,
    myStudentName: null,
    myScore: 0,
    myCorrect: 0,
    myWrong: 0,
    gameMode: 'paper',          // 'paper' | 'online'
    cameraReady: false,
    cameraStarting: false,
    sessionDataReady: false,
    drawerTab: 'pending',
    // Paper mode
    lastFlashStudentId: null,
    // Online mode
    countdownTimer: null,
    countdownLeft: 0,
    myAnswer: null,              // đáp án câu hiện tại
    questionAnswered: false
};

/* ===== UTILS ===== */
function uid(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`; }
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showView(viewId) {
    $$('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewId)?.classList.add('active');
}

function getCurrentQuestion(session) { return session?.questions?.[session.currentQuestionIndex] || null; }

function getAnswersForQuestion(session, questionId) {
    return (session?.answers || []).filter(a => a.questionId === questionId);
}

function getStudentAnswer(session, questionId, studentId) {
    return session?.answers?.find(a => a.questionId === questionId && a.studentId === studentId);
}

function computeMyScore(session, studentId, gameSettings) {
    if (!session?.questions?.length || !studentId) return { score: 0, correct: 0, wrong: 0 };
    const cfg = gameSettings || { scoringMode: 'per_question', basePoints: 500, maxPoints: 1000, timePerQuestion: 15 };
    const isTimeScoring = cfg.scoringMode === 'by_time';
    let score = 0, correct = 0, wrong = 0;
    session.questions.forEach(q => {
        const a = session.answers?.find(x => x.questionId === q.id && x.studentId === studentId);
        if (!a?.answer) return;
        if (a.answer === q.correctAnswer) {
            correct++;
            if (isTimeScoring) {
                const totalTime = (cfg.timePerQuestion || 15) * 1000;
                const responseTime = a.questionStartedAt ? (a.submittedAt - a.questionStartedAt) : totalTime / 2;
                const frac = Math.max(0, Math.min(1, 1 - responseTime / totalTime));
                score += Math.round((cfg.basePoints || 500) + ((cfg.maxPoints || 1000) - (cfg.basePoints || 500)) * frac);
            } else {
                score += cfg.basePoints || 500;
            }
        } else { wrong++; }
    });
    return { score, correct, wrong };
}

/* ===== SYNC ENGINE ===== */
const SyncEngine = {
    peer: null, conn: null, onMessage: null, reconnectTimer: null, statePollTimer: null,

    connectScanner(sessionId) {
        return new Promise((resolve) => {
            const hostId = 'pm-' + sessionId;
            try {
                this.peer?.destroy();
                this.peer = new Peer(undefined, { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
                this.peer.on('open', () => {
                    const conn = this.peer.connect(hostId, { reliable: true });
                    let settled = false;
                    const done = (ok) => { if (settled) return; settled = true; resolve(ok); };
                    conn.on('data', (data) => this._handle(data));
                    conn.on('open', () => { this.conn = conn; done(true); });
                    conn.on('error', () => done(false));
                    setTimeout(() => done(false), 10000);
                });
                this.peer.on('error', () => resolve(false));
            } catch { resolve(false); }
        });
    },
    _handle(msg) { if (this.onMessage) this.onMessage(msg); },
    send(msg) { if (this.conn?.open) this.conn.send(msg); },
    destroy() {
        clearInterval(this.reconnectTimer); clearInterval(this.statePollTimer);
        this.conn?.close(); this.peer?.destroy();
        this.conn = null; this.peer = null;
    },
    requestState() { this.send({ type: 'REQUEST_STATE' }); }
};

/* ===== ENTRY POINT ===== */
document.addEventListener('DOMContentLoaded', () => {
    bindBaseEvents();
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    const sessionParam = params.get('session');

    if (roomParam) {
        // Phòng máy: vào thẳng bằng link
        appState.gameMode = 'online';
        appState.roomCode = roomParam.toUpperCase();
        initOnlineMode(appState.roomCode);
    } else if (sessionParam) {
        // Quét thẻ giấy (paper mode — Plickers style)
        appState.gameMode = 'paper';
        appState.sessionId = sessionParam;
        initPaperMode(sessionParam);
    } else {
        // Hiện form nhập mã phòng
        showView('enter-code');
    }
});

/* ===== BASE EVENTS ===== */
function bindBaseEvents() {
    // Enter code form
    $('#btn-join-room')?.addEventListener('click', onJoinRoomClick);
    $('#room-code-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') onJoinRoomClick(); });
}

function onJoinRoomClick() {
    const inp = $('#room-code-input');
    const code = (inp?.value || '').trim().toUpperCase();
    if (!code) { setEnterCodeStatus('Nhập mã phòng', 'error'); return; }
    setEnterCodeStatus('Đang kết nối...', '');
    // Thử kết nối online mode trước (mã phòng 5 ký tự)
    appState.gameMode = 'online';
    appState.roomCode = code;
    initOnlineMode(code);
}

function setEnterCodeStatus(msg, type) {
    const el = $('#enter-code-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sv-status' + (type ? ' '+type : '');
}

/* ============================================================
   ONLINE MODE — học sinh bấm A/B/C/D
   ============================================================ */
function initOnlineMode(roomCode) {
    appState.sessionId = roomCode;
    showView('pick-name');
    $('#pick-room-badge').textContent = 'Phòng: ' + roomCode;
    setPickNameStatus('Đang kết nối tới phòng ' + roomCode + '...');

    // Kết nối PeerJS tới host
    SyncEngine.onMessage = handleOnlineMessage;
    SyncEngine.connectScanner(roomCode).then(ok => {
        if (ok) {
            setPickNameStatus('Đã kết nối! Đang lấy danh sách học sinh...');
            SyncEngine.send({ type: 'REQUEST_STATE' });
            // Poll nếu chưa nhận được dữ liệu
            SyncEngine.statePollTimer = setInterval(() => {
                if (appState.sessionDataReady) { clearInterval(SyncEngine.statePollTimer); return; }
                SyncEngine.send({ type: 'REQUEST_STATE' });
            }, 2000);
        } else {
            setPickNameStatus('Không kết nối được — kiểm tra mã phòng và thử lại', 'error');
            showView('enter-code');
            setEnterCodeStatus('Không tìm thấy phòng "' + roomCode + '"', 'error');
        }
    });

    // Reconnect loop
    SyncEngine.reconnectTimer = setInterval(() => {
        if (SyncEngine.conn?.open) return;
        SyncEngine.connectScanner(roomCode).then(ok => {
            if (ok && appState.session) SyncEngine.send({ type: 'REQUEST_STATE' });
        });
    }, 8000);
}

function setPickNameStatus(msg, type) {
    const el = $('#pick-name-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sv-status' + (type ? ' '+type : '');
}

function renderStudentPicker(session) {
    const grid = $('#student-name-list');
    if (!grid) return;
    const takenIds = new Set(Object.keys(session.onlineStudents || {}));
    grid.innerHTML = session.students.map(st => {
        const taken = takenIds.has(st.id) && st.id !== appState.myStudentId;
        return `<button class="sv-name-btn${taken?' taken':''}" data-student-id="${st.id}" data-student-name="${esc(st.name)}" ${taken?'disabled':''}>${esc(st.name)}</button>`;
    }).join('');
    grid.querySelectorAll('.sv-name-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            appState.myStudentId = btn.dataset.studentId;
            appState.myStudentName = btn.dataset.studentName;
            onStudentPicked();
        });
    });
    setPickNameStatus('');
}

function onStudentPicked() {
    if (!appState.myStudentId) return;
    // Thông báo cho host
    SyncEngine.send({
        type: 'STUDENT_JOINED',
        studentId: appState.myStudentId,
        name: appState.myStudentName,
        roomCode: appState.roomCode
    });
    showWaitingRoom();
}

function showWaitingRoom() {
    const session = appState.session;
    showView('waiting');
    $('#wait-room-badge').textContent = 'Phòng: ' + (appState.roomCode || appState.sessionId);
    $('#wait-student-name').textContent = appState.myStudentName || '—';
    // Nếu game đã bắt đầu (câu đang active), chuyển thẳng vào câu hỏi
    if (session && session.status === SESSION_STATUS.QUESTION_ACTIVE) {
        renderOnlineQuestion(session);
    } else if (session && session.status === SESSION_STATUS.QUESTION_RESULT) {
        renderOnlineResult(session);
    } else if (session && session.status === SESSION_STATUS.COMPLETED) {
        showEnded(session);
    }
}

function handleOnlineMessage(msg) {
    if (!msg?.type) return;
    const prevStatus = appState.session?.status;

    switch (msg.type) {
        case 'STATE_SYNC':
        case 'SESSION_CREATED':
            if (msg.session) mergeOnlineSession(msg.session);
            break;
        case 'QUESTION_CHANGED':
        case 'NEXT_QUESTION':
            if (msg.session) {
                mergeOnlineSession(msg.session);
                // Reset trạng thái trả lời cho câu mới
                if (msg.session.currentQuestionIndex !== appState.session?.currentQuestionIndex || prevStatus === SESSION_STATUS.QUESTION_RESULT) {
                    appState.myAnswer = null;
                    appState.questionAnswered = false;
                }
            }
            if (appState.myStudentId && appState.session?.status === SESSION_STATUS.QUESTION_ACTIVE) {
                renderOnlineQuestion(appState.session);
            }
            break;
        case 'QUESTION_RESULT':
        case 'QUESTION_LOCKED':
            if (msg.session) mergeOnlineSession(msg.session);
            if (appState.myStudentId) renderOnlineResult(appState.session);
            break;
        case 'SESSION_COMPLETED':
            if (msg.session) mergeOnlineSession(msg.session);
            showEnded(appState.session);
            break;
        case 'ANSWER_SCANNED':
        case 'ANSWER_UPDATED':
            if (msg.session) mergeOnlineSession(msg.session);
            break;
    }
}

function mergeOnlineSession(data) {
    if (!data) return;
    appState.session = JSON.parse(JSON.stringify(data));
    appState.sessionDataReady = true;

    const session = appState.session;
    if (!session.students?.length) return;

    // Nếu chưa vào tên → hiện picker
    if (!appState.myStudentId) {
        if (!$('#view-pick-name').classList.contains('active')) {
            showView('pick-name');
            $('#pick-room-badge').textContent = 'Phòng: ' + (appState.roomCode || session.id);
        }
        renderStudentPicker(session);
        return;
    }

    // Đã có tên → route theo trạng thái
    if (session.status === SESSION_STATUS.WAITING || session.status === SESSION_STATUS.CONNECTED) {
        showWaitingRoom();
    } else if (session.status === SESSION_STATUS.QUESTION_ACTIVE) {
        renderOnlineQuestion(session);
    } else if (session.status === SESSION_STATUS.QUESTION_RESULT || session.status === SESSION_STATUS.QUESTION_LOCKED) {
        renderOnlineResult(session);
    } else if (session.status === SESSION_STATUS.COMPLETED) {
        showEnded(session);
    }
}

/* ===== ONLINE QUESTION RENDER ===== */
function renderOnlineQuestion(session) {
    const q = getCurrentQuestion(session);
    if (!q) return;

    showView('question');
    const qIdx = session.currentQuestionIndex;
    const qTotal = session.questions.length;

    $('#q-room-info').textContent = 'Phòng: ' + (appState.roomCode || session.id);
    $('#q-num-label').textContent = `Câu ${qIdx+1}/${qTotal}`;
    $('#sv-submitted-banner').classList.add('hidden');

    // Nội dung câu hỏi
    $('#sv-question-text').textContent = q.question || '';
    const imgEl = $('#sv-question-image');
    if (imgEl) imgEl.innerHTML = q.questionImage ? `<img src="${q.questionImage}" alt="">` : '';

    // Đáp án
    const answersEl = $('#sv-answers');
    if (answersEl) {
        answersEl.innerHTML = ['A','B','C','D'].map(letter => {
            const ans = q.answers?.find(a => a.id === letter) || { text: letter };
            const isSelected = appState.myAnswer === letter;
            return `<button class="sv-ans-btn ${letter}${isSelected?' selected':''}" data-letter="${letter}">
                <span class="sv-ans-badge">${letter}</span>
                <span class="sv-ans-text">${esc(ans.text)}</span>
            </button>`;
        }).join('');
        answersEl.querySelectorAll('.sv-ans-btn').forEach(btn => {
            btn.addEventListener('click', () => onOnlineAnswerClick(btn.dataset.letter, session));
        });
    }

    // Nếu đã nộp rồi thì hiện banner
    const existing = getStudentAnswer(session, q.id, appState.myStudentId);
    if (existing?.answer) {
        appState.myAnswer = existing.answer;
        appState.questionAnswered = true;
        showSubmittedBanner(existing.answer);
        disableAnswerButtons();
    }

    // Countdown
    startStudentCountdown(session.gameSettings?.timePerQuestion || 15);

    $('#sv-status-bar').textContent = '';
}

function onOnlineAnswerClick(letter, session) {
    if (appState.questionAnswered) return;
    appState.myAnswer = letter;
    appState.questionAnswered = true;

    // Highlight selected
    $$('.sv-ans-btn').forEach(b => b.classList.toggle('selected', b.dataset.letter === letter));
    disableAnswerButtons();
    showSubmittedBanner(letter);

    // Dừng countdown
    stopStudentCountdown();

    // Gửi đáp án về host
    SyncEngine.send({
        type: 'ANSWER_SCANNED',
        studentId: appState.myStudentId,
        answer: letter,
        questionId: getCurrentQuestion(session)?.id,
        submittedAt: Date.now(),
        questionStartedAt: session._qStartedAt
    });

    $('#sv-status-bar').textContent = 'Đã gửi đáp án ✓';
}

function showSubmittedBanner(letter) {
    const banner = $('#sv-submitted-banner');
    if (banner) {
        banner.classList.remove('hidden');
        $('#sv-submitted-text').textContent = `✅ Đã chọn: ${letter}`;
    }
}

function disableAnswerButtons() {
    $$('.sv-ans-btn').forEach(b => { b.disabled = true; });
}

function startStudentCountdown(seconds) {
    stopStudentCountdown();
    let left = seconds;
    const circumference = 2 * Math.PI * 14; // r=14 ở SVG
    const update = () => {
        const numEl = $('#sv-countdown'); const ringEl = $('#sv-ring-fill');
        if (numEl) numEl.textContent = left;
        if (ringEl) {
            ringEl.style.strokeDashoffset = circumference * (1 - left/seconds);
            ringEl.classList.toggle('urgent', left <= 5);
        }
    };
    update();
    appState.countdownLeft = left;
    appState.countdownTimer = setInterval(() => {
        left--;
        appState.countdownLeft = left;
        update();
        if (left <= 0) { stopStudentCountdown(); }
    }, 1000);
}

function stopStudentCountdown() {
    if (appState.countdownTimer) { clearInterval(appState.countdownTimer); appState.countdownTimer = null; }
}

/* ===== ONLINE RESULT RENDER ===== */
function renderOnlineResult(session) {
    if (!session) return;
    stopStudentCountdown();

    const q = getCurrentQuestion(session);
    if (!q) return;

    showView('result');
    const qIdx = session.currentQuestionIndex;
    const qTotal = session.questions.length;
    $('#res-room-info').textContent = 'Phòng: ' + (appState.roomCode || session.id);
    $('#res-num-label').textContent = `Câu ${qIdx+1}/${qTotal}`;

    const myAns = appState.myAnswer;
    const isCorrect = myAns === q.correctAnswer;
    const noAns = !myAns;

    // Banner
    const banner = $('#sv-result-banner');
    if (banner) {
        if (noAns) { banner.textContent = '⏰ Hết giờ!'; banner.className = 'sv-result-banner timeout'; }
        else if (isCorrect) { banner.textContent = '✅ CHÍNH XÁC!'; banner.className = 'sv-result-banner correct'; }
        else { banner.textContent = `❌ Sai rồi! Đúng là ${q.correctAnswer}`; banner.className = 'sv-result-banner wrong'; }
    }

    // Hiện 4 đáp án với kết quả
    const resAns = $('#sv-result-answers');
    if (resAns) {
        resAns.innerHTML = ['A','B','C','D'].map(letter => {
            const ans = q.answers?.find(a => a.id === letter) || { text: letter };
            const isCorrectAns = letter === q.correctAnswer;
            const isMyWrong = letter === myAns && !isCorrectAns;
            let cls = 'other';
            if (isCorrectAns) cls = 'correct-ans';
            else if (isMyWrong) cls = 'my-ans-wrong';
            return `<div class="sv-res-ans-item ${cls}">
                <span class="sv-res-badge ${letter}">${letter}</span>
                <span>${esc(ans.text)}</span>
                ${isCorrectAns ? '<span style="margin-left:auto">✅</span>' : ''}
                ${isMyWrong ? '<span style="margin-left:auto">👈</span>' : ''}
            </div>`;
        }).join('');
    }

    // Cập nhật điểm
    const { score, correct, wrong } = computeMyScore(session, appState.myStudentId, session.gameSettings);
    appState.myScore = score;
    appState.myCorrect = correct;
    appState.myWrong = wrong;
    const scoreEl = $('#sv-score-val');
    if (scoreEl) scoreEl.textContent = session.gameSettings?.scoringMode === 'by_time' ? score : correct + '/' + qTotal;
}

/* ===== END ===== */
function showEnded(session) {
    stopStudentCountdown();
    showView('ended');
    $('#end-student-name').textContent = appState.myStudentName || '—';

    const { score, correct, wrong } = computeMyScore(session, appState.myStudentId, session?.gameSettings);
    const isTimeScoring = session?.gameSettings?.scoringMode === 'by_time';
    const qTotal = session?.questions?.length || 0;
    $('#end-score-val').textContent = isTimeScoring ? score : correct + '/' + qTotal;
    const correctEl = $('#end-correct-info');
    if (correctEl) {
        correctEl.textContent = `Đúng: ${correct} · Sai: ${wrong} · Không trả lời: ${qTotal - correct - wrong}`;
    }
}

/* ============================================================
   PAPER MODE — Plickers camera scanner
   (giữ nguyên từ bản cũ, chỉ đổi prefix PeerJS thành rcv-)
   ============================================================ */
async function initPaperMode(sessionId) {
    appState.sessionId = sessionId;
    appState.session = { id: sessionId, status: SESSION_STATUS.WAITING, students: [], questions: [], answers: [] };

    showView('waiting');
    $('#wait-room-badge').textContent = sessionId;
    $('#wait-student-name').textContent = 'Đang kết nối...';

    SyncEngine.onMessage = handlePaperMessage;
    const connected = await SyncEngine.connectScanner(sessionId);

    if (connected) {
        SyncEngine.send({ type: 'SCANNER_CONNECTED' });
        SyncEngine.send({ type: 'REQUEST_STATE' });
        SyncEngine.statePollTimer = setInterval(() => {
            if (appState.sessionDataReady) { clearInterval(SyncEngine.statePollTimer); return; }
            SyncEngine.send({ type: 'REQUEST_STATE' });
        }, 2000);
    } else {
        $('#wait-student-name').textContent = 'Chưa kết nối — mở phiên trên máy tính trước';
    }

    // Reconnect loop
    SyncEngine.reconnectTimer = setInterval(() => {
        if (SyncEngine.conn?.open) return;
        SyncEngine.connectScanner(sessionId).then(ok => {
            if (ok) {
                SyncEngine.send({ type: 'SCANNER_CONNECTED' });
                SyncEngine.send({ type: 'REQUEST_STATE' });
            }
        });
    }, 5000);
}

function handlePaperMessage(msg) {
    if (!msg?.type) return;
    const prevQIdx = appState.session?.currentQuestionIndex;
    const prevStatus = appState.session?.status;

    switch (msg.type) {
        case 'STATE_SYNC':
        case 'SESSION_CREATED':
        case 'QUESTION_CHANGED':
        case 'QUESTION_RESULT':
        case 'NEXT_QUESTION':
        case 'QUESTION_LOCKED':
        case 'ANSWER_SCANNED':
        case 'ANSWER_UPDATED':
            if (msg.session) mergePaperSession(msg.session);
            else renderPaperScanner();
            break;
        case 'SESSION_COMPLETED':
            if (msg.session) mergePaperSession(msg.session);
            else if (appState.session) { appState.session.status = SESSION_STATUS.COMPLETED; onPaperSessionUpdated(); }
            break;
    }

    const s = appState.session;
    const q = getCurrentQuestion(s);
    const qChanged = s && (s.currentQuestionIndex !== prevQIdx || s.status !== prevStatus);
    if (qChanged && q) CardScanner.onQuestionChanged(q.id);
}

function mergePaperSession(data) {
    if (!data) return;
    appState.session = data;
    onPaperSessionUpdated();
}

function onPaperSessionUpdated() {
    const s = appState.session;
    if (!s) return;
    if (s.status === SESSION_STATUS.COMPLETED) { CardScanner.stop(); showView('ended'); return; }
    if (s.questions?.length && s.students?.length) {
        appState.sessionDataReady = true;
        clearInterval(SyncEngine.statePollTimer);
        if (!appState.cameraReady && !appState.cameraStarting) {
            showView('waiting');
            $('#wait-student-name').textContent = 'Sẵn sàng quét';
        } else {
            renderPaperScanner();
        }
    }
}

function renderPaperScanner() {
    // Paper scanner dùng view question nhưng hiển thị camera
    // (tính năng camera sẽ hoạt động khi bấm "bắt đầu" từ lobby)
    const s = appState.session;
    if (!s?.questions?.length) return;
    const q = getCurrentQuestion(s);
    if (q) {
        showView('question');
        $('#sv-question-text').textContent = q.question || '';
        const answered = getAnswersForQuestion(s, q.id).filter(a => a.answer).length;
        const total = s.students.length;
        $('#sv-status-bar').textContent = `Đã quét: ${answered}/${total} học sinh`;
        $('#q-num-label').textContent = `Câu ${s.currentQuestionIndex+1}/${s.questions.length}`;

        const answersEl = $('#sv-answers');
        if (answersEl) {
            answersEl.innerHTML = ['A','B','C','D'].map(letter => {
                const ans = q.answers?.find(a => a.id === letter) || { text: letter };
                const cnt = getAnswersForQuestion(s, q.id).filter(a => a.answer === letter).length;
                return `<div class="sv-ans-btn ${letter}" style="cursor:default">
                    <span class="sv-ans-badge">${letter}</span>
                    <span class="sv-ans-text">${esc(ans.text)}</span>
                    ${s.status === SESSION_STATUS.QUESTION_RESULT ? `<span style="margin-left:auto;font-weight:800">${cnt}</span>` : ''}
                </div>`;
            }).join('');
        }
    }
}

/* ===== CARD SCANNER (Camera / Plickers CV — paper mode) ===== */
const CardScanner = {
    stream: null, rafId: null, frameCount: 0, pending: new Map(), confirmed: new Map(), questionKey: null,
    CONFIRM_FRAMES: 1,
    _lockKey(qId, stId) { return `${qId}_${stId}`; },
    resetForQuestion(qId) { this.pending.clear(); this.confirmed.clear(); this.questionKey = qId; this.frameCount = 0; this._seedFromAnswers(); },
    _seedFromAnswers() {
        const s = appState.session; const q = getCurrentQuestion(s); if (!s||!q) return;
        for (const st of s.students||[]) {
            const a = getStudentAnswer(s, q.id, st.id);
            if (a?.answer) this.confirmed.set(this._lockKey(q.id, st.id), a.answer);
        }
    },
    getConfirmedAnswer(stId, qId) { return this.confirmed.get(this._lockKey(qId, stId)) || null; },
    onQuestionChanged(qId) { if (qId) this.resetForQuestion(qId); },
    async start(videoEl, canvasEl) {
        if (this.stream) { this._ensureLoop(videoEl, canvasEl); return true; }
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
            videoEl.srcObject = this.stream; videoEl.setAttribute('playsinline','true'); videoEl.muted = true;
            await videoEl.play();
            appState.cameraReady = true; this._ensureLoop(videoEl, canvasEl); return true;
        } catch (e) { return false; }
    },
    stop() { cancelAnimationFrame(this.rafId); this.rafId=null; this.stream?.getTracks().forEach(t=>t.stop()); this.stream=null; this.pending.clear(); this.confirmed.clear(); appState.cameraReady=false; },
    _ensureLoop(video, canvas) { if (this.rafId) return; this._loop(video, canvas); },
    _loop(video, canvas) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = () => {
            this.rafId = requestAnimationFrame(tick);
            const status = appState.session?.status;
            if (status===SESSION_STATUS.QUESTION_LOCKED||status===SESSION_STATUS.QUESTION_RESULT) return;
            if (video.readyState < video.HAVE_ENOUGH_DATA) return;
            if (!video.videoWidth||!video.videoHeight) return;
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            this.frameCount++;
            if (this.frameCount % 2 !== 0) return;
            this._scanFrame(frame);
        };
        tick();
    },
    _scanFrame(frame) {
        const students = appState.session?.students || [];
        if (!students.length) return;
        const hits = MarkerUtil.decodeAll(frame.data, frame.width, frame.height, students);
        const q = getCurrentQuestion(appState.session);
        for (const hit of hits) this._trackHit(hit, q);
    },
    _trackHit(hit, q) {
        if (!q) return;
        if (this.questionKey !== q.id) this.resetForQuestion(q.id);
        const locked = this.getConfirmedAnswer(hit.student.id, q.id);
        if (locked === hit.orientation) return;
        let p = this.pending.get(hit.cardId);
        if (p && p.orientation === hit.orientation) { p.frames++; p.missed=0; }
        else { p = { orientation: hit.orientation, frames:1, missed:0, student:hit.student }; this.pending.set(hit.cardId, p); }
        if (p.frames >= this.CONFIRM_FRAMES) { this.pending.delete(hit.cardId); this._fireScan(hit.cardId, hit.orientation, hit.student); }
    },
    _fireScan(cardId, orientation, student) { onCardScanned(cardId, orientation, student); }
};

function onCardScanned(cardId, orientation, student) {
    const s = appState.session;
    if (!s?.students?.length) return;
    if (s.status===SESSION_STATUS.QUESTION_LOCKED||s.status===SESSION_STATUS.QUESTION_RESULT) return;
    const q = getCurrentQuestion(s); if (!q) return;

    // Ghi nhận local
    if (!s.answers) s.answers = [];
    const existingIdx = s.answers.findIndex(a => a.sessionId===s.id && a.questionId===q.id && a.studentId===student.id);
    const record = { id: uid('ans'), sessionId: s.id, questionId: q.id, studentId: student.id, cardId, answer: orientation, isCorrect: null, submittedAt: Date.now() };
    if (existingIdx >= 0) s.answers[existingIdx] = { ...s.answers[existingIdx], answer: orientation, submittedAt: Date.now() };
    else s.answers.push(record);

    CardScanner.confirmed.set(CardScanner._lockKey(q.id, student.id), orientation);

    // Gửi về presenter
    SyncEngine.send({ type: 'ANSWER_SCANNED', studentId: student.id, cardId, answer: orientation, questionId: q.id });
    renderPaperScanner();
}

/* ===== MARKER UTIL (Plickers — phải khớp hệt app.js presenter) ===== */
const MarkerUtil = {
    ORIENT: ['A','B','C','D'],
    DATA_CELLS: (() => {
        const cells = [];
        for (let r=1;r<=5;r++) for (let c=1;c<=5;c++) {
            if ((r===1||r===5)&&(c===1||c===5)) continue; cells.push([r,c]);
        }
        return cells;
    })(),
    MIN_CODE_DISTANCE: 7, _book: null, _bookSize: 0,
    buildBook(count) {
        const bits=this.DATA_CELLS.length; const book=[];
        let seed=0x1f2e3d4c>>>0;
        const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
        let guard=0;
        while(book.length<count&&guard<500000){
            guard++;
            const code=new Uint8Array(bits);let ones=0;
            for(let i=0;i<bits;i++){const b=(next()>>>18)&1;code[i]=b;ones+=b;}
            if(ones<6||ones>bits-6)continue;
            let ok=true;
            for(const prev of book){let d=0;for(let i=0;i<bits;i++)if(prev[i]!==code[i])d++;if(d<this.MIN_CODE_DISTANCE){ok=false;break;}}
            if(ok)book.push(code);
        }
        return book;
    },
    getCode(n){
        const need=Math.max(60,n+10);
        if(!this._book||this._bookSize<need){this._book=this.buildBook(need);this._bookSize=need;}
        return this._book[(Math.max(1,n)-1)%this._book.length];
    },
    getGrid(n){
        const grid=Array.from({length:7},()=>Array(7).fill(0));
        for(let i=0;i<7;i++){grid[0][i]=grid[6][i]=grid[i][0]=grid[i][6]=1;}
        grid[1][1]=1;grid[1][5]=0;grid[5][1]=0;grid[5][5]=0;
        const code=this.getCode(n);
        this.DATA_CELLS.forEach(([r,c],i)=>{grid[r][c]=code[i];});
        return grid;
    },
    getLegacyGrid(n){
        const grid=Array.from({length:7},()=>Array(7).fill(0));
        for(let i=0;i<7;i++){grid[0][i]=grid[6][i]=grid[i][0]=grid[i][6]=1;}
        let seed=n*7919+104729;
        for(let r=1;r<6;r++)for(let c=1;c<6;c++){seed=(seed*1103515245+12345)&0x7fffffff;grid[r][c]=(seed%3)!==0?1:0;}
        grid[1][1]=grid[1][5]=grid[5][1]=1;grid[5][5]=0;return grid;
    },
    _buildPatterns(students){
        const patterns=[];
        for(const st of students){
            patterns.push({student:st,grid:this.getGrid(st.cardNumber),legacy:false});
            patterns.push({student:st,grid:this.getLegacyGrid(st.cardNumber),legacy:true});
        }
        return patterns;
    },
    rotateGrid(grid,times){
        let g=grid.map(row=>[...row]);
        for(let t=0;t<times;t++){
            const n=g.length;const rotated=Array.from({length:n},()=>Array(n).fill(0));
            for(let r=0;r<n;r++)for(let c=0;c<n;c++)rotated[c][n-1-r]=g[r][c];
            g=rotated;
        }
        return g;
    },
    toGray(src,sw,sh,maxW){
        const scale=Math.min(1,maxW/sw);const w=Math.max(1,Math.round(sw*scale));const h=Math.max(1,Math.round(sh*scale));
        const gray=new Uint8Array(w*h);
        for(let y=0;y<h;y++){const sy=Math.min(sh-1,Math.round(y/scale));for(let x=0;x<w;x++){const sx=Math.min(sw-1,Math.round(x/scale));const i=(sy*sw+sx)*4;gray[y*w+x]=(src[i]*77+src[i+1]*150+src[i+2]*29)>>8;}}
        return{gray,w,h};
    },
    adaptiveThreshold(gray,w,h){
        const iw=w+1;const integral=new Uint32Array(iw*(h+1));
        for(let y=0;y<h;y++){let rs=0;for(let x=0;x<w;x++){rs+=gray[y*w+x];integral[(y+1)*iw+(x+1)]=integral[y*iw+(x+1)]+rs;}}
        const bin=new Uint8Array(w*h);const half=Math.max(4,Math.round(Math.min(w,h)/14));
        for(let y=0;y<h;y++){const y0=Math.max(0,y-half);const y1=Math.min(h-1,y+half);for(let x=0;x<w;x++){const x0=Math.max(0,x-half);const x1=Math.min(w-1,x+half);const area=(y1-y0+1)*(x1-x0+1);const sum=integral[(y1+1)*iw+(x1+1)]-integral[y0*iw+(x1+1)]-integral[(y1+1)*iw+x0]+integral[y0*iw+x0];bin[y*w+x]=gray[y*w+x]*area<sum*0.86?1:0;}}
        return bin;
    },
    findQuads(bin,w,h){
        const total=w*h;const seen=new Uint8Array(total);const stack=new Int32Array(total);const quads=[];
        const minArea=Math.max(120,Math.round(total/6000));const maxArea=Math.round(total*0.5);
        for(let start=0;start<total;start++){
            if(!bin[start]||seen[start])continue;
            let sp=0;stack[sp++]=start;seen[start]=1;
            let area=0,minX=w,maxX=-1,minY=h,maxY=-1,minSum=Infinity,maxSum=-Infinity,minDiff=Infinity,maxDiff=-Infinity,pTL=0,pBR=0,pBL=0,pTR=0;
            while(sp>0){
                const p=stack[--sp];const x=p%w;const y=(p/w)|0;area++;
                if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;
                const s=x+y;const d=x-y;
                if(s<minSum){minSum=s;pTL=p;}if(s>maxSum){maxSum=s;pBR=p;}if(d<minDiff){minDiff=d;pBL=p;}if(d>maxDiff){maxDiff=d;pTR=p;}
                for(let dy=-1;dy<=1;dy++){const ny=y+dy;if(ny<0||ny>=h)continue;for(let dx=-1;dx<=1;dx++){const nx=x+dx;if(nx<0||nx>=w)continue;const np=ny*w+nx;if(bin[np]&&!seen[np]){seen[np]=1;stack[sp++]=np;}}}
            }
            if(area<minArea||area>maxArea)continue;
            const bw=maxX-minX+1;const bh=maxY-minY+1;if(bw<16||bh<16)continue;
            const br=bw/bh;if(br<0.5||br>2)continue;
            const pt=p=>({x:p%w,y:(p/w)|0});const quad=[pt(pTL),pt(pTR),pt(pBR),pt(pBL)];
            if(!this.isSquarish(quad,area))continue;
            quads.push(quad);if(quads.length>=64)break;
        }
        return quads;
    },
    isSquarish(quad,area){
        const len=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
        const sides=[len(quad[0],quad[1]),len(quad[1],quad[2]),len(quad[2],quad[3]),len(quad[3],quad[0])];
        const mn=Math.min(...sides);const mx=Math.max(...sides);
        if(mn<14||mn/mx<0.55)return false;
        const qa=0.5*Math.abs((quad[0].x*quad[1].y-quad[1].x*quad[0].y)+(quad[1].x*quad[2].y-quad[2].x*quad[1].y)+(quad[2].x*quad[3].y-quad[3].x*quad[2].y)+(quad[3].x*quad[0].y-quad[0].x*quad[3].y));
        if(qa<=0)return false;const fill=area/qa;return fill>0.28&&fill<1.05;
    },
    samplePerspective(gray,w,h,quad){
        const n=7;const at=(u,v)=>{
            const x=(1-u)*(1-v)*quad[0].x+u*(1-v)*quad[1].x+u*v*quad[2].x+(1-u)*v*quad[3].x;
            const y=(1-u)*(1-v)*quad[0].y+u*(1-v)*quad[1].y+u*v*quad[2].y+(1-u)*v*quad[3].y;
            const xi=Math.round(x);const yi=Math.round(y);
            if(xi<0||yi<0||xi>=w||yi>=h)return -1;return gray[yi*w+xi];
        };
        const offsets=[[0.5,0.5],[0.33,0.33],[0.67,0.33],[0.33,0.67],[0.67,0.67]];
        const vals=Array.from({length:n},()=>Array(n).fill(255));
        for(let r=0;r<n;r++)for(let c=0;c<n;c++){let sum=0,count=0;for(const[ou,ov]of offsets){const v=at((c+ou)/n,(r+ov)/n);if(v>=0){sum+=v;count++;}}vals[r][c]=count?sum/count:255;}
        return vals;
    },
    binarizeCells(vals){
        const flat=[];for(const row of vals)for(const v of row)flat.push(v);
        const mn=Math.min(...flat);const mx=Math.max(...flat);if(mx-mn<35)return null;
        let threshold=(mn+mx)/2,bestVar=-1;
        for(let t=mn+2;t<mx;t+=3){let sL=0,nL=0,sH=0,nH=0;for(const v of flat){if(v<t){sL+=v;nL++;}else{sH+=v;nH++;}}if(!nL||!nH)continue;const diff=sL/nL-sH/nH;const vb=nL*nH*diff*diff;if(vb>bestVar){bestVar=vb;threshold=t;}}
        return vals.map(row=>row.map(v=>(v<threshold?1:0)));
    },
    hasBorderRing(grid){let dark=0;for(let i=0;i<7;i++){dark+=grid[0][i]+grid[6][i];if(i>0&&i<6)dark+=grid[i][0]+grid[i][6];}return dark>=21;},
    matchGrid(sampled,patterns){
        for(let rot=0;rot<4;rot++){
            const g=this.rotateGrid(sampled,rot);
            const mA=g[1][1]===1&&g[1][5]===0&&g[5][1]===0&&g[5][5]===0;
            const lA=g[1][1]===1&&g[1][5]===1&&g[5][1]===1&&g[5][5]===0;
            if(!mA&&!lA)continue;
            let best=null,secondDist=Infinity;
            for(const p of patterns){
                if(p.legacy&&!lA)continue;if(!p.legacy&&!mA)continue;
                let d=0;for(const[r,c]of this.DATA_CELLS)if(g[r][c]!==p.grid[r][c])d++;
                if(!best||d<best.d){secondDist=best?best.d:secondDist;best={d,student:p.student};}else if(d<secondDist)secondDist=d;
            }
            if(!best||best.d>4)continue;if(secondDist-best.d<1)continue;
            return{student:best.student,cardId:best.student.cardId,cardNumber:best.student.cardNumber,orientation:this.ORIENT[rot],dist:best.d};
        }
        return null;
    },
    decodeAll(imageData,width,height,students){
        if(!students?.length)return[];
        const{gray,w,h}=this.toGray(imageData,width,height,640);
        const bin=this.adaptiveThreshold(gray,w,h);
        const quads=this.findQuads(bin,w,h);
        if(!quads.length)return[];
        const patterns=this._buildPatterns(students);
        const byCard=new Map();
        for(const quad of quads){
            const vals=this.samplePerspective(gray,w,h,quad);
            const sampled=this.binarizeCells(vals);
            if(!sampled||!this.hasBorderRing(sampled))continue;
            const hit=this.matchGrid(sampled,patterns);if(!hit)continue;
            const prev=byCard.get(hit.cardId);
            if(!prev||hit.dist<prev.dist)byCard.set(hit.cardId,hit);
        }
        return Array.from(byCard.values());
    },
    rotateRgba90CW(data,w,h,times){
        let src=data,cw=w,ch=h;
        for(let t=0;t<times;t++){
            const out=new Uint8ClampedArray(cw*ch*4);const nw=ch,nh=cw;
            for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const si=(y*cw+x)*4;const nx=ch-1-y,ny=x;const di=(ny*nw+nx)*4;out[di]=src[si];out[di+1]=src[si+1];out[di+2]=src[si+2];out[di+3]=src[si+3];}
            src=out;cw=nw;ch=nh;
        }
        return{data:src,width:cw,height:ch};
    },
    decodeWithRotations(imageData,width,height,students,rotations){
        const perCard=new Map();
        for(const times of rotations){
            let data=imageData,w=width,h=height;
            if(times>0){const r=this.rotateRgba90CW(imageData,width,height,times);data=r.data;w=r.width;h=r.height;}
            const hits=this.decodeAll(data,w,h,students);
            for(const hit of hits){const prev=perCard.get(hit.cardId);if(!prev||hit.dist<prev.dist)perCard.set(hit.cardId,hit);}
        }
        return Array.from(perCard.values());
    }
};

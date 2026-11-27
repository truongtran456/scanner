'use strict';

/* ============================================================
   RUNG CHUÔNG VÀNG v3 — Scanner App (Chế độ Quét Thẻ)
   Deploy riêng trên Vercel. URL được trỏ từ config.js presenter.
   Flow: ?session=ID → kết nối PeerJS → nhận state → bật camera → quét thẻ → gửi đáp án
   ============================================================ */

const SESSION_STATUS = {
    WAITING:'WAITING', CONNECTED:'CONNECTED',
    QUESTION_ACTIVE:'QUESTION_ACTIVE', QUESTION_LOCKED:'QUESTION_LOCKED',
    QUESTION_RESULT:'QUESTION_RESULT', COMPLETED:'COMPLETED', RANKING:'RANKING'
};

const appState = {
    sessionId: null,
    session: null,
    cameraReady: false,
    sessionDataReady: false,
    lastScannedName: null
};

/* ===== UTILS ===== */
function uid(p='id'){return`${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`}
function $(s){return document.querySelector(s)}
function $$(s){return document.querySelectorAll(s)}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function showView(id){
    $$('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+id)?.classList.add('active');
}
function getCurrentQuestion(s){return s?.questions?.[s.currentQuestionIndex]||null}
function getAnswersForQuestion(s,qId){return(s?.answers||[]).filter(a=>a.questionId===qId)}
function getStudentAnswer(s,qId,stId){return s?.answers?.find(a=>a.questionId===qId&&a.studentId===stId)}

function showToast(msg,ms=2000){
    const t=$('#sc-toast');if(!t)return;
    t.textContent=msg;t.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t=setTimeout(()=>t.classList.add('hidden'),ms);
}
function showModal(html){
    $('#sc-modal-box').innerHTML=html;
    $('#sc-modal').classList.remove('hidden');
}
function hideModal(){$('#sc-modal').classList.add('hidden');$('#sc-modal-box').innerHTML=''}

/* ===== SOUND ===== */
function playSound(type){
    try{
        const ctx=playSound._ctx||(playSound._ctx=new(window.AudioContext||window.webkitAudioContext)());
        if(ctx.state==='suspended')ctx.resume();
        const now=ctx.currentTime;
        const sounds={
            scan:()=>{
                const o=ctx.createOscillator(),g=ctx.createGain();
                o.connect(g);g.connect(ctx.destination);
                o.type='sine';o.frequency.setValueAtTime(880,now);o.frequency.exponentialRampToValueAtTime(1200,now+.1);
                g.gain.setValueAtTime(.15,now);g.gain.exponentialRampToValueAtTime(.001,now+.15);
                o.start(now);o.stop(now+.15);
            },
            lock:()=>{
                [[440,0,.1],[440,.12,.1],[660,.24,.3]].forEach(([f,t,d])=>{
                    const o=ctx.createOscillator(),g=ctx.createGain();
                    o.connect(g);g.connect(ctx.destination);
                    o.type='square';o.frequency.value=f;
                    g.gain.setValueAtTime(.1,now+t);g.gain.exponentialRampToValueAtTime(.001,now+t+d);
                    o.start(now+t);o.stop(now+t+d);
                });
            },
            correct:()=>{
                [[523,0,.1],[659,.08,.1],[784,.16,.2],[1047,.26,.4]].forEach(([f,t,d])=>{
                    const o=ctx.createOscillator(),g=ctx.createGain();
                    o.connect(g);g.connect(ctx.destination);
                    o.type='triangle';o.frequency.value=f;
                    g.gain.setValueAtTime(.18,now+t);g.gain.exponentialRampToValueAtTime(.001,now+t+d);
                    o.start(now+t);o.stop(now+t+d);
                });
            },
            next:()=>{
                const o=ctx.createOscillator(),g=ctx.createGain();
                o.connect(g);g.connect(ctx.destination);
                o.type='sine';o.frequency.setValueAtTime(550,now);o.frequency.exponentialRampToValueAtTime(880,now+.2);
                g.gain.setValueAtTime(.15,now);g.gain.exponentialRampToValueAtTime(.001,now+.25);
                o.start(now);o.stop(now+.25);
            }
        };
        sounds[type]?.();
    }catch(_){}
}

/* ===== PEERJS ===== */
const SyncEngine = {
    peer:null, conn:null, onMessage:null,
    reconnectTimer:null, statePollTimer:null,

    connectScanner(sessionId){
        return new Promise(resolve=>{
            const hostId='pm-'+sessionId;
            try{
                this.peer?.destroy();
                this.peer=new Peer(undefined,{debug:0,config:{iceServers:[
                    {urls:'stun:stun.l.google.com:19302'},
                    {urls:'stun:stun1.l.google.com:19302'}
                ]}});
                this.peer.on('open',()=>{
                    const conn=this.peer.connect(hostId,{reliable:true});
                    let done=false;
                    const finish=ok=>{if(!done){done=true;resolve(ok)}};
                    conn.on('open',()=>{
                        this.conn=conn;
                        conn.on('data',d=>this._handle(d));
                        conn.on('close',()=>{this.conn=null});
                        finish(true);
                    });
                    conn.on('error',()=>finish(false));
                    setTimeout(()=>finish(false),12000);
                });
                this.peer.on('error',()=>resolve(false));
            }catch{resolve(false)}
        });
    },
    _handle(msg){if(this.onMessage)this.onMessage(msg)},
    send(msg){if(this.conn?.open)this.conn.send(msg)},
    destroy(){
        clearInterval(this.reconnectTimer);clearInterval(this.statePollTimer);
        this.conn?.close();this.peer?.destroy();this.conn=null;this.peer=null;
    }
};

/* ===== ENTRY ===== */
document.addEventListener('DOMContentLoaded',()=>{
    const params=new URLSearchParams(location.search);
    const sessionId=params.get('session');
    if(!sessionId){showView('error');$('#error-msg').textContent='Thiếu mã phiên — quét lại QR từ giáo viên.';return}
    bindEvents();
    init(sessionId);
});

async function init(sessionId){
    appState.sessionId=sessionId;
    appState.session={id:sessionId,status:SESSION_STATUS.WAITING,students:[],questions:[],answers:[]};

    showView('connecting');
    $('#session-code-badge').textContent=sessionId;
    $('#connect-status').textContent='Đang kết nối...';

    SyncEngine.onMessage=handleMessage;
    const ok=await SyncEngine.connectScanner(sessionId);

    if(!ok){
        $('#connect-status').textContent='❌ Không kết nối được — Mở phiên trên máy tính trước!';
        // Thử lại sau 5s
        setTimeout(()=>init(sessionId),5000);
        return;
    }

    $('#connect-status').textContent='✅ Đã kết nối!';
    SyncEngine.send({type:'SCANNER_CONNECTED'});
    SyncEngine.send({type:'REQUEST_STATE'});

    // Poll cho đến khi nhận được data
    SyncEngine.statePollTimer=setInterval(()=>{
        if(appState.sessionDataReady){clearInterval(SyncEngine.statePollTimer);return}
        SyncEngine.send({type:'REQUEST_STATE'});
    },2000);

    // Reconnect loop
    SyncEngine.reconnectTimer=setInterval(()=>{
        if(SyncEngine.conn?.open)return;
        SyncEngine.connectScanner(sessionId).then(r=>{
            if(r){SyncEngine.send({type:'SCANNER_CONNECTED'});SyncEngine.send({type:'REQUEST_STATE'})}
        });
    },5000);
}

/* ===== MESSAGE HANDLER ===== */
function handleMessage(msg){
    if(!msg?.type)return;
    const prevStatus=appState.session?.status;
    const prevQIdx=appState.session?.currentQuestionIndex;

    if(msg.session){
        appState.session=JSON.parse(JSON.stringify(msg.session));
        appState.sessionDataReady=true;
    }

    const s=appState.session;
    if(!s)return;

    switch(msg.type){
        case 'STATE_SYNC':
        case 'SESSION_CREATED':
        case 'QUESTION_CHANGED':
        case 'NEXT_QUESTION':
        case 'ANSWER_SCANNED':
        case 'ANSWER_UPDATED':
        case 'QUESTION_LOCKED':
        case 'QUESTION_RESULT':
            onSessionUpdated(s,prevStatus,prevQIdx,msg.type);
            break;
        case 'SESSION_COMPLETED':
            CardScanner.stop();
            showView('ended');
            break;
    }
}

function onSessionUpdated(s,prevStatus,prevQIdx,msgType){
    if(!s?.students?.length||!s?.questions?.length){
        showView('waiting');
        $('#wait-label').textContent='Đang tải dữ liệu...';
        return;
    }
    clearInterval(SyncEngine.statePollTimer);
    appState.sessionDataReady=true;

    // Cập nhật header room pill
    $$('#scan-room-pill,#res-room-pill').forEach(el=>{if(el)el.textContent='📌 '+s.id});

    if(s.status===SESSION_STATUS.COMPLETED){CardScanner.stop();showView('ended');return}

    if(s.status===SESSION_STATUS.WAITING||s.status===SESSION_STATUS.CONNECTED){
        showView('waiting');
        $('#wait-room-pill').textContent='📌 '+s.id;
        $('#wait-q-count').textContent=s.questions.length+' câu hỏi';
        $('#wait-st-count').textContent=s.students.length+' học sinh';
        $('#wait-label').textContent='Đang chờ giáo viên bắt đầu...';
        return;
    }

    if(s.status===SESSION_STATUS.QUESTION_RESULT||s.status===SESSION_STATUS.QUESTION_LOCKED){
        CardScanner.pause();
        showResultView(s);
        return;
    }

    if(s.status===SESSION_STATUS.QUESTION_ACTIVE){
        // Câu mới → reset scanner và bắt camera
        const q=getCurrentQuestion(s);
        if(q&&(prevQIdx!==s.currentQuestionIndex||prevStatus!==s.status)){
            CardScanner.onQuestionChanged(q.id);
        }
        startCamera(s);
        return;
    }
}

/* ===== CAMERA & SCAN ===== */
function startCamera(session){
    if(appState.cameraReady){
        showView('scanner');
        renderScannerUI(session);
        return;
    }
    showView('scanner');
    renderScannerUI(session);
    CardScanner.start($('#scanner-video'),$('#scanner-canvas')).then(ok=>{
        if(!ok){
            $('#sc-tip').textContent='❌ Không bật được camera — cho phép camera rồi thử lại';
            showToast('Cho phép camera để quét thẻ');
        }
    });
}

function renderScannerUI(session){
    const q=getCurrentQuestion(session);
    if(!q)return;
    const qIdx=session.currentQuestionIndex;
    const qTotal=session.questions.length;
    const answers=getAnswersForQuestion(session,q.id).filter(a=>a.answer);
    const total=session.students.length;
    const pct=total?Math.round(answers.length/total*100):0;

    $('#scan-q-pill').textContent=`Câu ${qIdx+1}/${qTotal}`;
    $('#scan-count-pill').textContent=`${answers.length}/${total}`;
    $('#sc-progress-fill').style.width=pct+'%';
    $('#sc-progress-label').textContent=`${answers.length}/${total} đã quét`;
    $('#sc-tip').textContent=answers.length>=total?'✅ Tất cả đã trả lời — có thể chốt câu':'Hướng camera vào thẻ học sinh';

    const lockBtn=$('#btn-lock-question');
    if(lockBtn){
        lockBtn.textContent=answers.length>=total?'🔒 CHỐT — ĐỦ RỒI!':'🔒 CHỐT CÂU';
        lockBtn.classList.toggle('ready',answers.length>=total);
    }
}

/* ===== RESULT VIEW ===== */
function showResultView(session){
    const q=getCurrentQuestion(session);
    if(!q)return;
    showView('result');
    const qIdx=session.currentQuestionIndex;
    const qTotal=session.questions.length;
    $('#res-q-pill').textContent=`Câu ${qIdx+1}/${qTotal}`;

    const allAns=getAnswersForQuestion(session,q.id);
    const total=session.students.length;
    const bars=$('#sc-result-bars');
    if(bars){
        bars.innerHTML=['A','B','C','D'].map((letter,li)=>{
            const cnt=allAns.filter(a=>a.answer===letter).length;
            const pct=total?Math.round(cnt/total*100):0;
            const isCorrect=letter===q.correctAnswer;
            const ans=q.answers?.find(a=>a.id===letter)||{text:letter};
            return `<div class="sc-bar-item${isCorrect?' correct-answer':''}" style="animation:fadeIn .4s ease both;animation-delay:${li*.07}s">
                <div class="sc-bar-top">
                    <span class="sc-ans-badge ${letter}">${letter}</span>
                    <span class="sc-bar-label">${esc(ans.text)}</span>
                    <span class="sc-bar-pct">${pct}%</span>
                    ${isCorrect?'<span class="sc-correct-badge">✅ ĐÚNG</span>':''}
                </div>
                <div class="sc-bar-track"><div class="sc-bar-fill ${letter}" style="width:0%" data-target="${pct}"></div></div>
                <div class="sc-bar-info">${cnt} bạn</div>
            </div>`;
        }).join('');
        requestAnimationFrame(()=>bars.querySelectorAll('.sc-bar-fill').forEach(el=>{el.style.width=el.dataset.target+'%'}));
    }

    const correctList=allAns.filter(a=>a.isCorrect);
    const wrongList=allAns.filter(a=>!a.isCorrect&&a.answer);
    const noAnsList=session.students.filter(st=>!allAns.find(a=>a.studentId===st.id&&a.answer));

    const chips=arr=>arr.map(a=>{
        const name=session.students.find(s=>s.id===(a.studentId||a.id))?.name||a.name||'?';
        return`<span class="sc-name-chip">${esc(name)}</span>`;
    }).join('');

    $('#sc-correct-count').textContent=correctList.length;
    $('#sc-correct-list').innerHTML=chips(correctList);
    $('#sc-wrong-count').textContent=wrongList.length;
    $('#sc-wrong-list').innerHTML=chips(wrongList);
    $('#sc-noans-count').textContent=noAnsList.length;
    $('#sc-noans-list').innerHTML=noAnsList.map(s=>`<span class="sc-name-chip">${esc(s.name)}</span>`).join('');

    // Nút next
    const nextBtn=$('#btn-next-question');
    if(nextBtn) nextBtn.textContent=qIdx<qTotal-1?'▶ Câu tiếp theo':'🏆 Kết thúc';

    playSound('lock');
    if(correctList.length>total/2){
        try{
            const ctx=playSound._ctx||(playSound._ctx=new(window.AudioContext||window.webkitAudioContext)());
            if(ctx.state==='suspended')ctx.resume();
            const now=ctx.currentTime;
            [[523,0,.15],[659,.12,.15],[784,.24,.15],[1047,.36,.5]].forEach(([f,t,d])=>{
                const o=ctx.createOscillator(),g=ctx.createGain();
                o.connect(g);g.connect(ctx.destination);
                o.type='triangle';o.frequency.value=f;
                g.gain.setValueAtTime(.15,now+t);g.gain.exponentialRampToValueAtTime(.001,now+t+d);
                o.start(now+t);o.stop(now+t+d);
            });
        }catch(_){}
    }
}

/* ===== EVENTS ===== */
function bindEvents(){
    // Chốt câu
    $('#btn-lock-question')?.addEventListener('click',()=>{
        SyncEngine.send({type:'LOCK_QUESTION'});
        showToast('Đã gửi lệnh chốt câu...');
    });

    // Câu tiếp
    $('#btn-next-question')?.addEventListener('click',()=>{
        SyncEngine.send({type:'NEXT_QUESTION'});
        SyncEngine.send({type:'REQUEST_STATE'});
        playSound('next');
    });

    // Menu
    $('#btn-scan-menu')?.addEventListener('click',()=>{
        showModal(`
            <h3>☰ Menu Scanner</h3>
            <ul class="sc-menu-list">
                <li><button id="mm-resync">🔄 Đồng bộ lại</button></li>
                <li><button id="mm-reload">📷 Reset camera</button></li>
                <li><button class="danger" id="mm-end">🛑 Kết thúc phiên</button></li>
            </ul>
            <button class="sc-modal-close" id="mm-close">Đóng</button>
        `);
        $('#mm-close')?.addEventListener('click',hideModal);
        $('#mm-resync')?.addEventListener('click',()=>{
            hideModal();SyncEngine.send({type:'REQUEST_STATE'});showToast('Đang đồng bộ...');
        });
        $('#mm-reload')?.addEventListener('click',()=>{
            hideModal();CardScanner.stop();appState.cameraReady=false;
            startCamera(appState.session);showToast('Đang reset camera...');
        });
        $('#mm-end')?.addEventListener('click',()=>{
            hideModal();
            if(confirm('Kết thúc phiên?')){SyncEngine.send({type:'END_SESSION'})}
        });
    });

    $('#sc-modal')?.addEventListener('click',e=>{if(e.target===$('#sc-modal'))hideModal()});
}

/* ===== CARD SCANNER (Camera + Plickers CV) ===== */
const CardScanner = {
    stream:null, rafId:null, frameCount:0,
    pending:new Map(), confirmed:new Map(), questionKey:null,
    _paused:false,
    CONFIRM_FRAMES:1,

    _lockKey:(qId,stId)=>`${qId}_${stId}`,

    resetForQuestion(qId){
        this.pending.clear();this.confirmed.clear();
        this.questionKey=qId;this.frameCount=0;
        // Seed từ answers đã có
        const s=appState.session;const q=getCurrentQuestion(s);
        if(!s||!q)return;
        for(const st of s.students||[]){
            const a=getStudentAnswer(s,q.id,st.id);
            if(a?.answer)this.confirmed.set(this._lockKey(q.id,st.id),a.answer);
        }
    },

    onQuestionChanged(qId){if(qId)this.resetForQuestion(qId);this._paused=false},
    pause(){this._paused=true},

    async start(videoEl,canvasEl){
        if(this.stream){this._ensureLoop(videoEl,canvasEl);return true}
        try{
            this.stream=await navigator.mediaDevices.getUserMedia({
                video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},
                audio:false
            });
            videoEl.srcObject=this.stream;
            videoEl.setAttribute('playsinline','true');
            videoEl.muted=true;
            await videoEl.play();
            // Chờ video ready
            await new Promise(res=>{
                if(videoEl.readyState>=2)return res();
                videoEl.onloadeddata=res;setTimeout(res,3000);
            });
            appState.cameraReady=true;
            this._ensureLoop(videoEl,canvasEl);
            return true;
        }catch(e){console.warn('Camera error:',e);return false}
    },

    stop(){
        cancelAnimationFrame(this.rafId);this.rafId=null;
        this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;
        this.pending.clear();this.confirmed.clear();
        appState.cameraReady=false;this._paused=false;
    },

    _ensureLoop(video,canvas){if(this.rafId)return;this._loop(video,canvas)},

    _loop(video,canvas){
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        const tick=()=>{
            this.rafId=requestAnimationFrame(tick);
            if(this._paused||!this.stream)return;
            const s=appState.session?.status;
            if(s===SESSION_STATUS.QUESTION_LOCKED||s===SESSION_STATUS.QUESTION_RESULT)return;
            if(video.readyState<video.HAVE_ENOUGH_DATA)return;
            if(!video.videoWidth||!video.videoHeight)return;
            canvas.width=video.videoWidth;canvas.height=video.videoHeight;
            ctx.drawImage(video,0,0);
            const frame=ctx.getImageData(0,0,canvas.width,canvas.height);
            this.frameCount++;
            if(this.frameCount%2!==0)return;
            this._scanFrame(frame);
        };
        tick();
    },

    _scanFrame(frame){
        const students=appState.session?.students||[];
        if(!students.length)return;
        const hits=MarkerUtil.decodeAll(frame.data,frame.width,frame.height,students);
        const q=getCurrentQuestion(appState.session);
        const seen=new Set();
        for(const hit of hits){seen.add(hit.cardId);this._trackHit(hit,q)}
        for(const[cardId,p]of this.pending){
            if(!seen.has(cardId)){p.missed=(p.missed||0)+1;if(p.missed>=4)this.pending.delete(cardId)}
        }
        if(hits.length){$('#sc-tip').textContent=`🎯 Đang nhận ${hits.length} thẻ...`}
    },

    _trackHit(hit,q){
        if(!q)return;
        if(this.questionKey!==q.id)this.resetForQuestion(q.id);
        const locked=this.confirmed.get(this._lockKey(q.id,hit.student.id));
        if(locked===hit.orientation)return;
        let p=this.pending.get(hit.cardId);
        if(p&&p.orientation===hit.orientation){p.frames++;p.missed=0}
        else{p={orientation:hit.orientation,frames:1,missed:0,student:hit.student};this.pending.set(hit.cardId,p)}
        if(p.frames>=this.CONFIRM_FRAMES){this.pending.delete(hit.cardId);this._fireScan(hit.cardId,hit.orientation,hit.student)}
    },

    _fireScan(cardId,orientation,student){onCardScanned(cardId,orientation,student)}
};

function onCardScanned(cardId,orientation,student){
    const s=appState.session;
    if(!s?.students?.length)return;
    const status=s.status;
    if(status===SESSION_STATUS.QUESTION_LOCKED||status===SESSION_STATUS.QUESTION_RESULT)return;
    const q=getCurrentQuestion(s);if(!q)return;

    // Ghi nhận local
    if(!s.answers)s.answers=[];
    const existing=s.answers.findIndex(a=>a.sessionId===s.id&&a.questionId===q.id&&a.studentId===student.id);
    const record={id:uid('ans'),sessionId:s.id,questionId:q.id,studentId:student.id,
        cardId,answer:orientation,isCorrect:null,submittedAt:Date.now()};
    if(existing>=0)s.answers[existing]={...s.answers[existing],answer:orientation,submittedAt:Date.now()};
    else s.answers.push(record);

    CardScanner.confirmed.set(CardScanner._lockKey(q.id,student.id),orientation);

    // Gửi về presenter
    SyncEngine.send({
        type:'ANSWER_SCANNED',
        studentId:student.id,cardId,answer:orientation,questionId:q.id,
        session:JSON.parse(JSON.stringify(s))
    });

    // Flash UI
    const flash=$('#scan-flash');
    if(flash){flash.classList.remove('hidden');setTimeout(()=>flash.classList.add('hidden'),400)}

    const lastFlash=$('#scan-last-flash');
    if(lastFlash){
        lastFlash.textContent=`✓ ${student.name} → ${orientation}`;
        lastFlash.classList.remove('hidden');
        clearTimeout(onCardScanned._t);
        onCardScanned._t=setTimeout(()=>lastFlash.classList.add('hidden'),1200);
    }

    playSound('scan');
    renderScannerUI(s);
}

/* ===== MARKER UTIL (Plickers — phải khớp hệt app.js presenter) ===== */
const MarkerUtil={
    ORIENT:['A','B','C','D'],
    DATA_CELLS:(()=>{const cells=[];for(let r=1;r<=5;r++)for(let c=1;c<=5;c++){if((r===1||r===5)&&(c===1||c===5))continue;cells.push([r,c])}return cells})(),
    MIN_CODE_DISTANCE:7,_book:null,_bookSize:0,
    buildBook(count){
        const bits=this.DATA_CELLS.length;const book=[];
        let seed=0x1f2e3d4c>>>0;
        const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed};
        let guard=0;
        while(book.length<count&&guard<500000){
            guard++;const code=new Uint8Array(bits);let ones=0;
            for(let i=0;i<bits;i++){const b=(next()>>>18)&1;code[i]=b;ones+=b}
            if(ones<6||ones>bits-6)continue;
            let ok=true;
            for(const prev of book){let d=0;for(let i=0;i<bits;i++)if(prev[i]!==code[i])d++;if(d<this.MIN_CODE_DISTANCE){ok=false;break}}
            if(ok)book.push(code);
        }
        return book;
    },
    getCode(n){
        const need=Math.max(60,n+10);
        if(!this._book||this._bookSize<need){this._book=this.buildBook(need);this._bookSize=need}
        return this._book[(Math.max(1,n)-1)%this._book.length];
    },
    getGrid(n){
        const grid=Array.from({length:7},()=>Array(7).fill(0));
        for(let i=0;i<7;i++){grid[0][i]=grid[6][i]=grid[i][0]=grid[i][6]=1}
        grid[1][1]=1;grid[1][5]=0;grid[5][1]=0;grid[5][5]=0;
        const code=this.getCode(n);this.DATA_CELLS.forEach(([r,c],i)=>{grid[r][c]=code[i]});return grid;
    },
    getLegacyGrid(n){
        const grid=Array.from({length:7},()=>Array(7).fill(0));
        for(let i=0;i<7;i++){grid[0][i]=grid[6][i]=grid[i][0]=grid[i][6]=1}
        let seed=n*7919+104729;
        for(let r=1;r<6;r++)for(let c=1;c<6;c++){seed=(seed*1103515245+12345)&0x7fffffff;grid[r][c]=(seed%3)!==0?1:0}
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
        for(let y=0;y<h;y++){const sy=Math.min(sh-1,Math.round(y/scale));for(let x=0;x<w;x++){const sx=Math.min(sw-1,Math.round(x/scale));const i=(sy*sw+sx)*4;gray[y*w+x]=(src[i]*77+src[i+1]*150+src[i+2]*29)>>8}}
        return{gray,w,h};
    },
    adaptiveThreshold(gray,w,h){
        const iw=w+1;const integral=new Uint32Array(iw*(h+1));
        for(let y=0;y<h;y++){let rs=0;for(let x=0;x<w;x++){rs+=gray[y*w+x];integral[(y+1)*iw+(x+1)]=integral[y*iw+(x+1)]+rs}}
        const bin=new Uint8Array(w*h);const half=Math.max(4,Math.round(Math.min(w,h)/14));
        for(let y=0;y<h;y++){const y0=Math.max(0,y-half);const y1=Math.min(h-1,y+half);for(let x=0;x<w;x++){const x0=Math.max(0,x-half);const x1=Math.min(w-1,x+half);const area=(y1-y0+1)*(x1-x0+1);const sum=integral[(y1+1)*iw+(x1+1)]-integral[y0*iw+(x1+1)]-integral[(y1+1)*iw+x0]+integral[y0*iw+x0];bin[y*w+x]=gray[y*w+x]*area<sum*.86?1:0}}
        return bin;
    },
    findQuads(bin,w,h){
        const total=w*h;const seen=new Uint8Array(total);const stack=new Int32Array(total);const quads=[];
        const minArea=Math.max(120,Math.round(total/6000));const maxArea=Math.round(total*.5);
        for(let start=0;start<total;start++){
            if(!bin[start]||seen[start])continue;
            let sp=0;stack[sp++]=start;seen[start]=1;
            let area=0,mnX=w,mxX=-1,mnY=h,mxY=-1,mnS=Infinity,mxS=-Infinity,mnD=Infinity,mxD=-Infinity,pTL=0,pBR=0,pBL=0,pTR=0;
            while(sp>0){
                const p=stack[--sp];const x=p%w;const y=(p/w)|0;area++;
                if(x<mnX)mnX=x;if(x>mxX)mxX=x;if(y<mnY)mnY=y;if(y>mxY)mxY=y;
                const s=x+y;const d=x-y;
                if(s<mnS){mnS=s;pTL=p}if(s>mxS){mxS=s;pBR=p}if(d<mnD){mnD=d;pBL=p}if(d>mxD){mxD=d;pTR=p}
                for(let dy=-1;dy<=1;dy++){const ny=y+dy;if(ny<0||ny>=h)continue;for(let dx=-1;dx<=1;dx++){const nx=x+dx;if(nx<0||nx>=w)continue;const np=ny*w+nx;if(bin[np]&&!seen[np]){seen[np]=1;stack[sp++]=np}}}
            }
            if(area<minArea||area>maxArea)continue;
            const bw=mxX-mnX+1;const bh=mxY-mnY+1;if(bw<16||bh<16)continue;
            const br=bw/bh;if(br<.5||br>2)continue;
            const pt=p=>({x:p%w,y:(p/w)|0});const quad=[pt(pTL),pt(pTR),pt(pBR),pt(pBL)];
            if(!this.isSquarish(quad,area))continue;
            quads.push(quad);if(quads.length>=64)break;
        }
        return quads;
    },
    isSquarish(quad,area){
        const len=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
        const sides=[len(quad[0],quad[1]),len(quad[1],quad[2]),len(quad[2],quad[3]),len(quad[3],quad[0])];
        const mn=Math.min(...sides);const mx=Math.max(...sides);if(mn<14||mn/mx<.55)return false;
        const qa=.5*Math.abs((quad[0].x*quad[1].y-quad[1].x*quad[0].y)+(quad[1].x*quad[2].y-quad[2].x*quad[1].y)+(quad[2].x*quad[3].y-quad[3].x*quad[2].y)+(quad[3].x*quad[0].y-quad[0].x*quad[3].y));
        if(qa<=0)return false;const fill=area/qa;return fill>.28&&fill<1.05;
    },
    samplePerspective(gray,w,h,quad){
        const n=7;const at=(u,v)=>{
            const x=(1-u)*(1-v)*quad[0].x+u*(1-v)*quad[1].x+u*v*quad[2].x+(1-u)*v*quad[3].x;
            const y=(1-u)*(1-v)*quad[0].y+u*(1-v)*quad[1].y+u*v*quad[2].y+(1-u)*v*quad[3].y;
            const xi=Math.round(x);const yi=Math.round(y);if(xi<0||yi<0||xi>=w||yi>=h)return -1;return gray[yi*w+xi];
        };
        const offsets=[[.5,.5],[.33,.33],[.67,.33],[.33,.67],[.67,.67]];
        const vals=Array.from({length:n},()=>Array(n).fill(255));
        for(let r=0;r<n;r++)for(let c=0;c<n;c++){let sum=0,count=0;for(const[ou,ov]of offsets){const v=at((c+ou)/n,(r+ov)/n);if(v>=0){sum+=v;count++}}vals[r][c]=count?sum/count:255}
        return vals;
    },
    binarizeCells(vals){
        const flat=[];for(const row of vals)for(const v of row)flat.push(v);
        const mn=Math.min(...flat);const mx=Math.max(...flat);if(mx-mn<35)return null;
        let threshold=(mn+mx)/2,bestVar=-1;
        for(let t=mn+2;t<mx;t+=3){let sL=0,nL=0,sH=0,nH=0;for(const v of flat){if(v<t){sL+=v;nL++}else{sH+=v;nH++}}if(!nL||!nH)continue;const diff=sL/nL-sH/nH;const vb=nL*nH*diff*diff;if(vb>bestVar){bestVar=vb;threshold=t}}
        return vals.map(row=>row.map(v=>(v<threshold?1:0)));
    },
    hasBorderRing(grid){let dark=0;for(let i=0;i<7;i++){dark+=grid[0][i]+grid[6][i];if(i>0&&i<6)dark+=grid[i][0]+grid[i][6]}return dark>=21},
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
                if(!best||d<best.d){secondDist=best?best.d:secondDist;best={d,student:p.student}}else if(d<secondDist)secondDist=d;
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
        const quads=this.findQuads(bin,w,h);if(!quads.length)return[];
        const patterns=this._buildPatterns(students);const byCard=new Map();
        for(const quad of quads){
            const vals=this.samplePerspective(gray,w,h,quad);const sampled=this.binarizeCells(vals);
            if(!sampled||!this.hasBorderRing(sampled))continue;
            const hit=this.matchGrid(sampled,patterns);if(!hit)continue;
            const prev=byCard.get(hit.cardId);if(!prev||hit.dist<prev.dist)byCard.set(hit.cardId,hit);
        }
        return Array.from(byCard.values());
    }
};

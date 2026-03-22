const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// --- CẤU HÌNH HỆ THỐNG ---
const HISTORY_DIR = path.join(__dirname, 'data/history');
const LEARNING_FILE = path.join(HISTORY_DIR, 'learning_data_sun.json');
const EXTERNAL_HISTORY_FILE = path.join(HISTORY_DIR, 'external_history_sun.json');

if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// --- BIẾN TOÀN CỤC ---
let externalHistory = [];
const MAX_HISTORY = 100;
const MIN_DATA_TO_PREDICT = 15;
let wsConnected = false;
let currentSessionId = null;

// --- HỆ THỐNG TRỌNG SỐ NÂNG CAO (ADAPTIVE WEIGHTS) ---
const BASE_WEIGHTS = {
    STREAK: 2.8,        // Soi cầu bệt
    REVERSAL: 2.2,      // Soi cầu đảo 1-1
    PATTERN_22: 1.8,    // Soi cầu 2-2, 3-3
    MARKOV: 2.5,        // Xác suất thống kê chuỗi
    SUM_PRESSURE: 1.5,  // Áp lực tổng điểm xúc xắc
    MOMENTUM: 1.2       // Xu hướng dòng chảy điểm số
};

// --- DATA PERSISTENCE ---
function loadAllData() {
    try {
        if (fs.existsSync(EXTERNAL_HISTORY_FILE)) {
            externalHistory = JSON.parse(fs.readFileSync(EXTERNAL_HISTORY_FILE, 'utf8'));
            console.log(`[System] Đã tải ${externalHistory.length} phiên lịch sử.`);
        }
    } catch (e) { console.error("Lỗi load data:", e); }
}

function saveAllData() {
    try {
        fs.writeFileSync(EXTERNAL_HISTORY_FILE, JSON.stringify(externalHistory, null, 2));
    } catch (e) { console.error("Lỗi save data:", e); }
}

// --- CÁC HÀM THUẬT TOÁN BỔ TRỢ (HELPER FUNCTIONS) ---

// 1. Phân tích chuỗi bệt (Streak Analysis)
function getStreakInfo(results) {
    let streak = 1;
    for (let i = 0; i < results.length - 1; i++) {
        if (results[i] === results[i + 1]) streak++; else break;
    }
    return { type: results[0], length: streak };
}

// 2. Thuật toán Markov Chain (Dự đoán dựa trên trạng thái trước)
function getMarkovPrediction(results) {
    let taiToTai = 0, taiToXiu = 0, xiuToTai = 0, xiuToXiu = 0;
    for (let i = 0; i < results.length - 1; i++) {
        if (results[i] === 1) (results[i + 1] === 1) ? taiToTai++ : taiToXiu++;
        else (results[i + 1] === 1) ? xiuToTai++ : xiuToXiu++;
    }
    const current = results[0];
    if (current === 1) return taiToTai >= taiToXiu ? 1 : 0;
    return xiuToTai >= xiuToXiu ? 1 : 0;
}

// 3. Phân tích áp lực tổng điểm (Sum Pressure - Tương tự RSI)
function getSumPressure(sums) {
    const lastSum = sums[0];
    const avg = sums.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    if (lastSum >= 15) return -1; // Quá cao -> Ép về Xỉu
    if (lastSum <= 6) return 1;   // Quá thấp -> Ép về Tài
    return (lastSum > avg) ? -0.5 : 0.5;
}

// --- HÀM TÍNH TOÁN TỔNG HỢP (THE MASTER PREDICTOR) ---
function predictNextHand(history) {
    const results = history.map(h => h.Ket_qua === "Tài" ? 1 : 0);
    const sums = history.map(h => h.Tong);
    
    let finalScore = 0;

    // A. PHÂN TÍCH CẦU (Pattern Analysis)
    const streak = getStreakInfo(results);
    if (streak.length >= 3) {
        finalScore += (streak.type === 1 ? BASE_WEIGHTS.STREAK : -BASE_WEIGHTS.STREAK);
    }

    // B. PHÂN TÍCH ĐẢO (1-1, 2-2)
    if (results[0] !== results[1] && results[1] !== results[2]) {
        finalScore += (results[0] === 1 ? -BASE_WEIGHTS.REVERSAL : BASE_WEIGHTS.REVERSAL);
    }
    if (results[0] === results[1] && results[2] === results[3] && results[1] !== results[2]) {
        finalScore += (results[0] === 1 ? -BASE_WEIGHTS.PATTERN_22 : BASE_WEIGHTS.PATTERN_22);
    }

    // C. XÁC SUẤT MARKOV
    const markovGuess = getMarkovPrediction(results);
    finalScore += (markovGuess === 1 ? BASE_WEIGHTS.MARKOV : -BASE_WEIGHTS.MARKOV);

    // D. ÁP LỰC ĐIỂM SỐ
    const pressure = getSumPressure(sums);
    finalScore += pressure * BASE_WEIGHTS.SUM_PRESSURE;

    // E. KẾT LUẬN
    const prediction = finalScore >= 0 ? "Tài" : "Xỉu";
    const confidence = Math.min(99, 50 + Math.abs(finalScore) * 7.5);

    return {
        side: prediction,
        confidence: Math.round(confidence),
        analysis: {
            streak: streak.length,
            lastSum: sums[0],
            score: finalScore.toFixed(2)
        }
    };
}

// --- KẾT NỐI WEBSOCKET ---
const WEBSOCKET_URL = "wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0";
const WS_HEADERS = { "User-Agent": "Mozilla/5.0", "Origin": "https://play.sun.win" };

const initialMessages = [
    [1, "MiniGame", "GM_anhlocbuwin", "WangLin", { "info": "{\"ipAddress\":\"14.172.129.70\",\"wsToken\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJ0aWdlcl9idV93aW4iLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50IjpmYWxzZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjozMTg2NjY3MDEsImFmZklkIjoiZGVmYXVsdCIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoic3VuLndpbiIsInRpbWVzdGFtcCI6MTc3MTIzMTgwMzQ5OCwibG9ja0dhbWVzIjpbXSwiYW1vdW50IjowLCJsb2NrQ2hhdCI6ZmFsc2UsInBob25lVmVyaWZpZWQiOmZhbHNlLCJpcEFkZHJlc3MiOiIxNC4xNzIuMTI5LjcwIiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wNC5wbmciLCJwbGF0Zm9ybUlkIjoxLCJ1c2VySWQiOiJlZGE0NDAzYS03ZDllLTQ5NTUtYWVkMy0mSDEwNTZiNWEwNTEzZiIsInJlZ1RpbWUiOjE3NTg4MDIyMzI0MzgsInBob25lIjoiIiwiZGVwb3NpdCI6dHJ1ZSwidXNlcm5hbWUiOiJTQ19hbmhsb2NidXdpbiJ9.4FT1xAunF09GJzm276zFrM9V2BYd_BPsO_4mcdcRh-w\",\"locale\":\"vi\",\"userId\":\"eda4403a-7d9e-4955-aed3-1056b5a0513f\",\"username\":\"SC_anhlocbuwin\",\"timestamp\":1771231803499,\"refreshToken\":\"30fcde93570147388b3f92df33d75663.3180ff6693d9473db4027954e57c92b3\"}", "signature": "8D0448B9546D9F26855DE6B2A6C6B8F420137E610755CD8DCF78AE54528DA479757B5287127E936C84440A2DE1349CCA41A37B6A4A0254639BD4FF660AA6455B19666EABFE7C7B81A10A499199A9C23DFC2DF2AE188C483D21B17075DCFE472AE4C684915476B1F7C5E56F98306E18435CC5771774D859EAFD0B26E8D3A30EE" }],
    [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }],
    [6, "MiniGame", "lobbyPlugin", { cmd: 10001 }]
];

function connectWS() {
    const ws = new WebSocket(WEBSOCKET_URL, { headers: WS_HEADERS });
    
    ws.on('open', () => {
        wsConnected = true;
        console.log("✅ WebSocket SunWin Live!");
        initialMessages.forEach((msg, i) => {
            setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }, i * 1000);
        });
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            // Cập nhật Session ID
            if (Array.isArray(data) && data[1].cmd === 1008) currentSessionId = data[1].sid;
            
            // Lấy kết quả khi phiên kết thúc
            if (Array.isArray(data) && data[1].cmd === 1003 && data[1].gBB) {
                const { d1, d2, d3 } = data[1];
                const phien = currentSessionId;
                if (!externalHistory.find(h => h.Phien === phien)) {
                    externalHistory.unshift({
                        Phien: phien,
                        Tong: d1 + d2 + d3,
                        Ket_qua: (d1 + d2 + d3) > 10 ? "Tài" : "Xỉu",
                        Time: new Date().toLocaleTimeString()
                    });
                    if (externalHistory.length > MAX_HISTORY) externalHistory.pop();
                    saveAllData();
                    console.log(`[New Result] Phiên ${phien}: ${d1+d2+d3} -> ${ (d1+d2+d3) > 10 ? "Tài" : "Xỉu" }`);
                }
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        wsConnected = false;
        console.log("⚠️ Mất kết nối. Đang thử lại...");
        setTimeout(connectWS, 5000);
    });
}

// --- API ENDPOINTS ---
app.get('/taixiu', (req, res) => {
    if (externalHistory.length < MIN_DATA_TO_PREDICT) {
        return res.json({ status: "Waiting", data_needed: MIN_DATA_TO_PREDICT - externalHistory.length });
    }
    const result = predictNextHand(externalHistory);
    const nextPhien = (parseInt(externalHistory[0].Phien) + 1).toString();
    
    res.json({
        phien: nextPhien,
        du_doan: result.side,
        ti_le: `${result.confidence}%`,
        id: "@mryanhdz",
        analysis: result.analysis
    });
});

app.get('/debug', (req, res) => {
    res.json({
        wsConnected,
        historyCount: externalHistory.length,
        lastPhien: externalHistory[0] || null
    });
});

// --- KHỞI CHẠY ---
loadAllData();
connectWS();
app.listen(PORT, () => {
    console.log(`====================================`);
    console.log(`🚀 AURORA TOOL SERVER STARTED ON PORT ${PORT}`);
    console.log(`📡 WebSocket: Monitoring SunWin...`);
    console.log(`====================================`);
});
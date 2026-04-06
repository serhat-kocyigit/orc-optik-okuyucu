// OMR Scanner Module - Optik Form Okuma Mantığı
const OMR_CONFIG = {
    questions: 20,
    choices: ['A', 'B', 'C', 'D', 'E'],
    detectionThreshold: 0.3,
    fillThreshold: 175, // Siyah/koyu işaretlemeler için optimize
};

let model;
let cvReady = false;
let uploadedImage = null;

const elements = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    scanBtn: document.getElementById('scan-btn'),
    canvas: document.getElementById('output-canvas'),
    loader: document.getElementById('loader'),
    welcomeMsg: document.getElementById('welcome-msg'),
    resId: document.getElementById('res-id'),
    resCount: document.getElementById('res-count'),
};

// --- INIT ---
(async function init() {
    if (!elements.dropZone) return; // Sayfa elementleri yoksa çalışma

    const scripts = [
        'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs/dist/tf.min.js',
        'https://docs.opencv.org/4.10.0/opencv.js'
    ];

    for (let src of scripts) {
        if (document.querySelector(`script[src="${src}"]`)) continue;
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        document.head.appendChild(script);
        await new Promise(r => script.onload = r);
    }

    try {
        if (typeof cv !== 'undefined') {
            if (cv.getBuildInformation) cvReady = true;
            else cv['onRuntimeInitialized'] = () => cvReady = true;
        }
        model = await tf.loadGraphModel('/model/model.json');
        console.log('OMR Scanner initialized');
    } catch (err) {
        console.error('Model loading error:', err);
    }

    setupEventListeners();
})();

function setupEventListeners() {
    if (!elements.dropZone) return;

    elements.dropZone.onclick = () => elements.fileInput.click();
    elements.fileInput.onchange = (e) => handleFiles(e.target.files);
    elements.dropZone.ondragover = (e) => { 
        e.preventDefault(); 
        elements.dropZone.classList.add('active'); 
    };
    elements.dropZone.ondragleave = () => elements.dropZone.classList.remove('active');
    elements.dropZone.ondrop = (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('active');
        handleFiles(e.dataTransfer.files);
    };

    elements.scanBtn.onclick = async () => {
        if (!uploadedImage || !model || !cvReady) return;
        elements.loader.style.display = 'flex';
        elements.scanBtn.disabled = true;
        try {
            console.log("Analysis starting...");
            const results = await performAnalysis();
            console.log("Analysis complete:", results);
            displayResults(results);
        } catch (err) {
            console.error(err);
            alert("Hata: " + err.message);
        } finally {
            elements.loader.style.display = 'none';
            elements.scanBtn.disabled = false;
        }
    };
}

function handleFiles(files) {
    if (files.length === 0) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            uploadedImage = img;
            if (elements.welcomeMsg) elements.welcomeMsg.classList.add('hidden');
            if (elements.canvas) elements.canvas.classList.remove('hidden');
            if (elements.scanBtn) elements.scanBtn.disabled = false;
            const ctx = elements.canvas.getContext('2d');
            elements.canvas.width = img.width;
            elements.canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(files[0]);
}

async function performAnalysis() {
    const ctx = elements.canvas.getContext('2d');

    // 🔥 Tensor hazırla
    const imgTensor = tf.browser.fromPixels(elements.canvas);
    const resized = tf.image.resizeBilinear(imgTensor, [640, 640]);
    const input = resized.div(255).expandDims(0);

    // 🔥 YOLO inference
    const preds = await model.executeAsync(input);
    const data = await preds.data();

    const elementsCount = data.length / 5;

    let boxes = [];

    for (let i = 0; i < elementsCount; i++) {
        const conf = data[4 * elementsCount + i];

        if (conf > OMR_CONFIG.detectionThreshold) {
            boxes.push({
                x: data[i],
                y: data[elementsCount + i],
                w: data[2 * elementsCount + i],
                h: data[3 * elementsCount + i],
                score: conf
            });
        }
    }

    preds.dispose();
    input.dispose();

    if (boxes.length === 0) throw new Error("Optik form alanı bulunamadı.");

    // 🔥 EN İYİ BOX SEÇ
    const best = boxes.sort((a, b) => b.score - a.score)[0];

    // 🔥 SCALE (640 → gerçek boyut)
    const scale = {
        x: uploadedImage.width / 640,
        y: uploadedImage.height / 640
    };

    // 🔥 GENİŞLETME (daha stabil crop)
    const expansionX = (best.w * scale.x) * 0.40;

    let ax = Math.max(0, (best.x - best.w / 2) * scale.x - expansionX);
    let ay = Math.max(0, (best.y - best.h / 2) * scale.y - 20);
    let aw = (best.w * scale.x) + expansionX * 2.5;
    let ah = (best.h * scale.y) + 40;

    if (ax + aw > uploadedImage.width) aw = uploadedImage.width - ax - 1;
    if (ay + ah > uploadedImage.height) ah = uploadedImage.height - ay - 1;

    const area = {
        x: Math.floor(ax),
        y: Math.floor(ay),
        w: Math.floor(aw),
        h: Math.floor(ah)
    };

    // =========================
    // 🔥 OPENCV
    // =========================
    const src = cv.imread(elements.canvas);
    const gray = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const cropped = gray.roi(new cv.Rect(area.x, area.y, area.w, area.h));

    const thresh = new cv.Mat();

    cv.adaptiveThreshold(
        cropped,
        thresh,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        35,
        3
    );

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    cv.findContours(
        thresh,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE
    );

    let bubbles = [];

    for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);

        const areaCnt = cv.contourArea(cnt);
        const perimeter = cv.arcLength(cnt, true);

        const circularity = (perimeter > 0)
            ? (4 * Math.PI * areaCnt / (perimeter * perimeter))
            : 0;

        const aspect = rect.width / rect.height;

        if (
            rect.width > area.w * 0.015 &&
            rect.width < area.w * 0.1 &&
            aspect > 0.75 &&
            aspect < 1.35 &&
            circularity > 0.3
        ) {
            const cx = rect.x + rect.width / 2 + area.x;
            const cy = rect.y + rect.height / 2 + area.y;

            bubbles.push({
                x: rect.x + area.x,
                y: rect.y + area.y,
                w: rect.width,
                h: rect.height,
                cx,
                cy
            });

            // 🔥 debug çizim
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
            ctx.beginPath();
            ctx.arc(cx, cy, rect.width / 2, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    const results = mapToGrid(ctx, bubbles, area);

    // cleanup
    src.delete();
    gray.delete();
    cropped.delete();
    thresh.delete();
    contours.delete();
    hierarchy.delete();

    return results;
}

function mapToGrid(ctx, bubbles, area) {
    if (!bubbles || bubbles.length === 0) {
        return { studentID: "-----", answers: [] };
    }

    // =========================
    // 1. İŞARETLİLER
    // =========================
    const marked = bubbles.filter(b => {
        const r = Math.max(2, Math.floor(b.w * 0.28));
        const data = ctx.getImageData(
            Math.max(0, b.cx - r),
            Math.max(0, b.cy - r),
            r * 2,
            r * 2
        ).data;

        let bright = 0;
        for (let i = 0; i < data.length; i += 4) {
            bright += (data[i] + data[i + 1] + data[i + 2]) / 3;
        }

        const avg = bright / (data.length / 4 || 1);
        const isFilled = avg < OMR_CONFIG.fillThreshold;

        if (isFilled) {
            ctx.fillStyle = 'rgba(34,197,94,0.9)';
            ctx.beginPath();
            ctx.arc(b.cx, b.cy, b.w / 2 + 2, 0, Math.PI * 2);
            ctx.fill();
        }

        return isFilled;
    });

    // =========================
    // 2. SADECE SORU ALANI
    // =========================
    const questionBubbles = bubbles.filter(
        b => (b.cx - area.x) / area.w > 0.35
    );

    if (questionBubbles.length < 40) {
        console.warn("Bubble sayısı düşük");
    }

    // =========================
    // 3. X'e göre kolon bul
    // =========================
    const sortedX = [...questionBubbles].sort((a, b) => a.cx - b.cx);

    const columns = [];
    let current = [sortedX[0]];
    const colThreshold = area.w * 0.03;

    for (let i = 1; i < sortedX.length; i++) {
        if (Math.abs(sortedX[i].cx - current[0].cx) < colThreshold) {
            current.push(sortedX[i]);
        } else {
            columns.push(current);
            current = [sortedX[i]];
        }
    }
    columns.push(current);

    // sağdan sola sırala (KRİTİK)
    columns.sort((a, b) => b[0].cx - a[0].cx);

    // SADECE EN SAĞDAKİ 10 KOLONU AL
    const selectedCols = columns.slice(0, 10);

    // tekrar soldan sağa diz
    selectedCols.sort((a, b) => a[0].cx - b[0].cx);

    const leftCols = selectedCols.slice(0, 5);
    const rightCols = selectedCols.slice(5, 10);

    // =========================
    // 4. SONUÇ
    // =========================
    const answers = Array.from({ length: 20 }, (_, i) => ({
        q: i + 1,
        ans: null
    }));

    // =========================
    // 5. SOL KOLON (1–10)
    // =========================
    leftCols.forEach((col, colIndex) => {
        // EN ALTA GÖRE SIRALA
        col.sort((a, b) => b.cy - a.cy);

        // SADECE EN ALT 10 BALONCUK
        const bottom10 = col.slice(0, 10);

        bottom10.forEach((b, rowIndex) => {
            if (marked.includes(b)) {
                const qIndex = 10 - rowIndex - 1;

                if (qIndex >= 0 && qIndex < 20) {
                    answers[qIndex].ans = OMR_CONFIG.choices[colIndex];
                }

                ctx.strokeStyle = "yellow";
                ctx.strokeRect(b.x, b.y, b.w, b.h);
            }
        });
    });

    // =========================
    // 6. SAĞ KOLON (11–20)
    // =========================
    rightCols.forEach((col, colIndex) => {
        col.sort((a, b) => b.cy - a.cy);

        const bottom10 = col.slice(0, 10);

        bottom10.forEach((b, rowIndex) => {
            if (marked.includes(b)) {
                const qIndex = 10 + (10 - rowIndex - 1);

                if (qIndex >= 0 && qIndex < 20) {
                    answers[qIndex].ans = OMR_CONFIG.choices[colIndex];
                }

                ctx.strokeStyle = "lime";
                ctx.strokeRect(b.x, b.y, b.w, b.h);
            }
        });
    });

    // =========================
// 7. ÖĞRENCİ NO (SOL + EN ALT REFERANS)
// =========================
let studentID = "";

const idBubbles = bubbles.filter(
    b => (b.cx - area.x) / area.w < 0.4
);

if (idBubbles.length > 5) {

    // SOL → SAĞ sıralama
    idBubbles.sort((a, b) => a.cx - b.cx);

    // SÜTUNLARA AYIR
    const cols = [];
    let cur = [idBubbles[0]];

    for (let i = 1; i < idBubbles.length; i++) {
        if (Math.abs(idBubbles[i].cx - cur[0].cx) < area.w * 0.02) {
            cur.push(idBubbles[i]);
        } else {
            cols.push(cur);
            cur = [idBubbles[i]];
        }
    }
    cols.push(cur);

    // 🔥 SADECE EN SOL 5 SÜTUN
    const selected = cols.slice(0, 5);

    selected.forEach((col, colIndex) => {

        // 🔥 EN ALT → EN ÜST sırala
        col.sort((a, b) => b.cy - a.cy);

        // 🔥 SADECE EN ALT 10 BALON
        const bottom10 = col.slice(0, 10);

        let digit = "-";

        bottom10.forEach((b, i) => {
            if (marked.includes(b)) {
                digit = 9-i; // 🔥 EN ALT = 0, yukarı doğru 1,2,3...
                
                // debug çiz
                ctx.strokeStyle = "cyan";
                ctx.strokeRect(b.x, b.y, b.w, b.h);
            }
        });

        studentID += digit;
    });
}

return {
    studentID: studentID || "-----",
    answers
};
}
function displayResults(data) {
    if (elements.resId) elements.resId.innerText = data.studentID;
    if (elements.resCount) elements.resCount.innerText = data.answers.filter(a => a.ans).length + " / 20";
    
    // Bu fonksiyon sayfa tarafından override edilebilir
    if (window.onScanComplete) {
        window.onScanComplete(data);
    }
}

// Export for use in other scripts
window.OMRScanner = {
    config: OMR_CONFIG,
    performAnalysis,
    displayResults
};

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

    // 🔥 EN YÜKSEK CONFIDENCE'LI BOX'U SEÇ (processImage gibi)
    let bestConf = 0;
    let best = null;
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.score > bestConf) {
            bestConf = b.score;
            best = b;
        }
    }

    if (!best) throw new Error("Geçerli form alanı bulunamadı.");

    // 🔥 SCALE (640 → gerçek boyut) - processImage ile aynı
    const xScale = uploadedImage.width / 640;
    const yScale = uploadedImage.height / 640;

    // 🔥 DÜZ CROP HESAPLAMA (processImage ile birebir aynı)
    let startX = Math.max(0, Math.floor((best.x - best.w / 2) * xScale));
    let startY = Math.max(0, Math.floor((best.y - best.h / 2) * yScale));
    let w = Math.floor(best.w * xScale);
    let h = Math.floor(best.h * yScale);

    // Güvenlik kontrolü - makul değerlerde mi?
    if (w > uploadedImage.width) w = Math.floor(uploadedImage.width * 0.5);
    if (h > uploadedImage.height) h = Math.floor(uploadedImage.height * 0.8);

    // 🔥 SOLA GENİŞLET - öğrenci numarası için (AZ)
    const leftExpand = Math.min(Math.floor(w * 0.6), Math.floor(uploadedImage.width * 0.25)); // Max %25 görüntü genişliği
    startX = Math.max(0, startX - leftExpand);
    w = Math.min(w + leftExpand, uploadedImage.width - startX);

    const area = {
        x: startX,
        y: startY,
        w: w,
        h: h
    };
    // ... (Önceki kodların: area objesinin oluşturulduğu yer)

    // 🔥 AI'nın Seçtiği Alanı Görselleştir (Kırmızı Kesikli Çizgi)
    // NOT: Görselleştirme CROP sonrası yapılmalı (canvas zaten crop'lu değil)
    // Crop alanını orijinal canvas üzerinde göster
    const displayScaleX = elements.canvas.width / uploadedImage.width;
    const displayScaleY = elements.canvas.height / uploadedImage.height;

    const rx = area.x * displayScaleX;
    const ry = area.y * displayScaleY;
    const rw = area.w * displayScaleX;
    const rh = area.h * displayScaleY;

    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.strokeRect(rx, ry, rw, rh);

    ctx.fillStyle = '#ff0000';
    ctx.font = 'bold 16px sans-serif';
    ctx.setLineDash([]);
    ctx.fillText(`AI Crop Alanı (%${(best.score * 100).toFixed(1)})`, rx, ry - 10);

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

    // 1. İŞARETLİLERİ TESPİT ET
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

    const answers = Array.from({ length: 20 }, (_, i) => ({ q: i + 1, ans: null }));

    // 2. SORU ALANINDAKİ BALONCUKLARI BUL VE SATIRLARA GRUPLA
    const questionBubbles = bubbles.filter(b => (b.cx - area.x) / area.w > 0.35);

    // Satırları Y eksenine göre grupla
    questionBubbles.sort((a, b) => a.cy - b.cy);
    const rows = [];
    if (questionBubbles.length > 0) {
        let currentRow = [questionBubbles[0]];
        for (let i = 1; i < questionBubbles.length; i++) {
            if (Math.abs(questionBubbles[i].cy - currentRow[0].cy) < area.h * 0.04) {
                currentRow.push(questionBubbles[i]);
            } else {
                rows.push(currentRow.sort((a, b) => b.cx - a.cx)); // Satırı SAĞDAN SOLA sırala
                currentRow = [questionBubbles[i]];
            }
        }
        rows.push(currentRow.sort((a, b) => b.cx - a.cx));
    }

    // Beklenen 10 satırı işle (1-10 ve 11-20 yan yana)
    // En üstteki satırlar genellikle başlık vs. olabilir, biz en alttaki 10 satırı baz alalım veya en düzenli olanları.
    // Ancak genellikle formun geri kalanı temizdir.
    const validRows = rows.filter(r => r.length >= 10).slice(-10); // En son 10 satır (ana cevap anahtarı)

    validRows.forEach((row, rowIndex) => {
        const qIdx_right = 10 + rowIndex; // 11-20
        const qIdx_left = rowIndex;       // 1-10

        // 1. SAĞ KOLON (11-20) - İlk 5 baloncuk
        const rightBubbles = row.slice(0, 5);
        rightBubbles.forEach((b, choiceIdx) => {
            if (marked.includes(b)) {
                answers[qIdx_right].ans = OMR_CONFIG.choices[4 - choiceIdx];
                ctx.strokeStyle = "lime";
                ctx.strokeRect(b.x, b.y, b.w, b.h);
            }
        });

        // 2. BOŞLUK ANALİZİ (Gelişmiş Gap Detection)
        // En sağdan itibaren 9 baloncuğun arasındaki mesafeleri ölçüyoruz.
        let maxGap = 0;
        let splitIdx = 4; // Default: A2 ile sonrası arası

        const searchLimit = Math.min(row.length - 1, 9);
        for (let i = 0; i < searchLimit; i++) {
            const current = row[i];
            const next = row[i + 1];
            const currentGap = current.cx - next.cx; // Sağdan sola olduğu için .cx azalıyor

            if (currentGap > maxGap) {
                maxGap = currentGap;
                splitIdx = i; // En büyük boşluğun sağındaki baloncuk indeksi
            }
        }

        // En büyük boşluğun solundaki baloncuğu (splitIdx + 1) Birinci Kolonun başlangıcı (E) kabul et
        const col1StartIdx = splitIdx + 1;
        const leftBubbles = row.slice(col1StartIdx, col1StartIdx + 5);

        leftBubbles.forEach((b, choiceIdx) => {
            if (marked.includes(b)) {
                answers[qIdx_left].ans = OMR_CONFIG.choices[4 - choiceIdx];
                ctx.strokeStyle = "yellow";
                ctx.strokeRect(b.x, b.y, b.w, b.h);
            }
        });
    });

    // 3. ÖĞRENCİ NO
    let studentID = "";
    const idBubbles = bubbles.filter(b => (b.cx - area.x) / area.w < 0.4);

    if (idBubbles.length > 5) {
        idBubbles.sort((a, b) => a.cx - b.cx);
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

        const selected = cols.slice(0, 5); // İlk 5 sütun
        selected.forEach(col => {
            col.sort((a, b) => a.cy - b.cy); // Üstten alta 0-9
            let digit = "-";
            col.forEach((b, i) => {
                if (marked.includes(b)) {
                    digit = i;
                    ctx.strokeStyle = "cyan";
                    ctx.strokeRect(b.x, b.y, b.w, b.h);
                }
            });
            studentID += digit;
        });
    }

    return { studentID: studentID || "-----", answers };
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

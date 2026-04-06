// OMR logic with accurate grid detection and row/col clustering
const OMR_CONFIG = {
    questions: 20,
    choices: ['A', 'B', 'C', 'D', 'E'],
    detectionThreshold: 0.3,
    fillThreshold: 175, // Sensitivity for dark marks (Higher = More sensitive)
};

let model;
let cvReady = false;

const elements = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    scanBtn: document.getElementById('scan-btn'),
    canvas: document.getElementById('output-canvas'),
    loader: document.getElementById('loader'),
    welcomeMsg: document.getElementById('welcome-msg'),
    resId: document.getElementById('res-id'),
    resCount: document.getElementById('res-count'),
    answersGrid: document.getElementById('answers-grid'),
    status: document.getElementById('server-status')
};

// --- INIT ---
(async function init() {
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
        elements.status.innerText = 'Sistem Hazır';
    } catch (err) {
        elements.status.innerText = 'Model Hatası';
        elements.status.className = 'badge badge-danger';
    }
})();

// --- FILE OPS ---
elements.dropZone.onclick = () => elements.fileInput.click();
elements.fileInput.onchange = (e) => handleFiles(e.target.files);
elements.dropZone.ondragover = (e) => { e.preventDefault(); elements.dropZone.classList.add('active'); };
elements.dropZone.ondragleave = () => elements.dropZone.classList.remove('active');
elements.dropZone.ondrop = (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('active');
    handleFiles(e.dataTransfer.files);
};

let uploadedImage = null;

function handleFiles(files) {
    if (files.length === 0) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            uploadedImage = img;
            elements.welcomeMsg.classList.add('hidden');
            elements.canvas.classList.remove('hidden');
            elements.scanBtn.disabled = false;
            const ctx = elements.canvas.getContext('2d');
            elements.canvas.width = img.width;
            elements.canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(files[0]);
}

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

async function performAnalysis() {
    const ctx = elements.canvas.getContext('2d');
    const imgTensor = tf.browser.fromPixels(elements.canvas);
    const resized = tf.image.resizeBilinear(imgTensor, [640, 640]);
    const input = resized.div(255).expandDims(0);

    const predictions = await model.predict(input);
    const data = await predictions.array();
    const boxData = data[0];

    const boxes = [];
    for (let i = 0; i < boxData[0].length; i++) {
        if (boxData[4][i] > OMR_CONFIG.detectionThreshold) {
            boxes.push({ x: boxData[0][i], y: boxData[1][i], w: boxData[2][i], h: boxData[3][i], score: boxData[4][i] });
        }
    }

    if (boxes.length === 0) throw new Error("Answers area area not found.");
    const best = boxes.sort((a, b) => b.score - a.score)[0];
    const scale = { x: uploadedImage.width / 640, y: uploadedImage.height / 640 };

    const expansionX = (best.w * scale.x) * 0.40; // Sola doğru payı %40'a çıkardım (Daha geniş alan)
    let ax = Math.max(0, (best.x - best.w / 2) * scale.x - expansionX);
    let ay = Math.max(0, (best.y - best.h / 2) * scale.y - 20);
    let aw = (best.w * scale.x) + expansionX * 2.5;
    let ah = (best.h * scale.y) + 40;

    // Resim sınırlarına sığdır (OpenCV ROI çökmesini engellemek için)
    if (ax + aw > uploadedImage.width) aw = uploadedImage.width - ax - 1;
    if (ay + ah > uploadedImage.height) ah = uploadedImage.height - ay - 1;

    const area = { x: Math.floor(ax), y: Math.floor(ay), w: Math.floor(aw), h: Math.floor(ah) };

    // Process with OpenCV
    const src = cv.imread(elements.canvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const cropped = gray.roi(new cv.Rect(area.x, area.y, area.w, area.h));
    const thresh = new cv.Mat();
    // Eşiği daha yumuşak yaparak boş (beyaz) baloncukların ince çizgilerini de yakalayalım
    cv.adaptiveThreshold(cropped, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 35, 3);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bubbles = [];
    for (let i = 0; i < contours.size(); ++i) {
        const cnt = contours.get(i);
        const rect = cv.boundingRect(cnt);
        const areaCnt = cv.contourArea(cnt);
        const perimeter = cv.arcLength(cnt, true);
        const circularity = (perimeter > 0) ? (4 * Math.PI * areaCnt / (perimeter * perimeter)) : 0;
        const aspect = rect.width / rect.height;

        // Tüm baloncukları (dolu-boş) yakalamak için sınırları esnetiyoruz
        if (rect.width > area.w * 0.015 && rect.width < area.w * 0.1 &&
            aspect > 0.75 && aspect < 1.35 && circularity > 0.5) {
            bubbles.push({
                x: rect.x + area.x, y: rect.y + area.y,
                w: rect.width, h: rect.height,
                cx: rect.x + rect.width / 2 + area.x,
                cy: rect.y + rect.height / 2 + area.y
            });

            // Debug: Tüm algılananları Kırmızı ile çiz
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
            ctx.beginPath(); ctx.arc(bubbles[bubbles.length - 1].cx, bubbles[bubbles.length - 1].cy, rect.width / 2, 0, Math.PI * 2); ctx.stroke();
        }
    }

    const results = mapToGrid(ctx, bubbles, area);

    // Cleanup
    src.delete(); gray.delete(); cropped.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    return results;
}

function mapToGrid(ctx, bubbles, area) {
    if (!bubbles || bubbles.length === 0) return { studentID: "-----", answers: [] };

    // 1. İşaretli Baloncukları Tespit Et
    const marked = bubbles.filter(b => {
        const r = Math.max(2, Math.floor(b.w * 0.28));
        const data = ctx.getImageData(Math.max(0, b.cx - r), Math.max(0, b.cy - r), r * 2, r * 2).data;
        let bright = 0;
        for (let i = 0; i < data.length; i += 4) bright += (data[i] + data[i + 1] + data[i + 2]) / 3;
        const avg = bright / (data.length / 4 || 1);
        const isFilled = avg < OMR_CONFIG.fillThreshold;
        if (isFilled) {
            ctx.fillStyle = 'rgba(234, 180, 8, 0.85)';
            ctx.beginPath(); ctx.arc(b.cx, b.cy, b.w / 2 + 2, 0, Math.PI * 2); ctx.fill();
        }
        return isFilled;
    });

    // 2. Satır Gruplama (Y eksenine göre) - ALTTAN YUKARI
    // Baloncukları Y eksenine göre ters (büyükten küçüğe) diziyoruz
    bubbles.sort((a, b) => b.cy - a.cy);
    const rows = [];
    if (bubbles.length > 0) {
        let curRow = [bubbles[0]];
        for (let i = 1; i < bubbles.length; i++) {
            const last = curRow[curRow.length - 1];
            // Aynı satırda sayılma töleransı
            if (Math.abs(bubbles[i].cy - last.cy) < (area.h * 0.04)) {
                curRow.push(bubbles[i]);
            } else {
                rows.push(curRow.sort((a, b) => a.cx - b.cx)); // Satır içini soldan sağa diz
                curRow = [bubbles[i]];
            }
        }
        if (curRow.length > 0) rows.push(curRow.sort((a, b) => a.cx - b.cx));
    }

    // 3. Veri Eşleştirme (Gelişmiş Filtreleme ve Boşluk Analizi)
    const answers = Array.from({ length: 20 }, (_, i) => ({ q: i + 1, ans: null }));

    // Soru Alanı (Ana Izgara) Genellikle resmin sağ tarafındadır (relX > 0.35)
    const questionBubbles = bubbles.filter(b => (b.cx - area.x) / area.w > 0.35);

    // Soru satırlarını kendi içinde grupla
    questionBubbles.sort((a, b) => b.cy - a.cy);
    const qRows = [];
    if (questionBubbles.length > 0) {
        let cur = [questionBubbles[0]];
        for (let i = 1; i < questionBubbles.length; i++) {
            if (Math.abs(questionBubbles[i].cy - cur[cur.length - 1].cy) < (area.h * 0.04)) cur.push(questionBubbles[i]);
            else { qRows.push(cur.sort((a, b) => a.cx - b.cx)); cur = [questionBubbles[i]]; }
        }
        if (cur.length > 0) qRows.push(cur.sort((a, b) => a.cx - b.cx));
    }

    // En alttaki 10 satırı işle (Cevap satırları)
    qRows.slice(0, 10).forEach((row, idxFromBottom) => {
        const qRowIdx = 10 - idxFromBottom - 1;
        row.sort((a, b) => a.cx - b.cx);

        // Satırın ortasını bul
        const rowMid = (row[0].cx + row[row.length - 1].cx) / 2;

        // Sol Grup (1-10) ve Sağ Grup (11-20)
        const leftPart = row.filter(b => b.cx < rowMid);
        const rightPart = row.filter(b => b.cx >= rowMid);

        // Her birinde en sağdaki (son) 5 baloncuğu al (Sayıları/gürültüyü elemek için)
        leftPart.sort((a, b) => a.cx - b.cx).slice(-5).forEach((b, cIdx) => {
            if (marked.includes(b)) answers[qRowIdx].ans = OMR_CONFIG.choices[cIdx];
        });

        rightPart.sort((a, b) => a.cx - b.cx).slice(-5).forEach((b, cIdx) => {
            if (marked.includes(b)) answers[qRowIdx + 10].ans = OMR_CONFIG.choices[cIdx];
        });
    });

    // 4. Öğrenci No Alanı (Geliştirilmiş 5 Sütun Ayırma)
    let studentID = "";
    const idBubblesRange = bubbles.filter(b => (b.cx - area.x) / area.w < 0.4);

    if (idBubblesRange.length > 5) {
        // Sütunları Ayır - Boşluk payını daralttım (0.015) ki yandaki sütunla birleşmesin.
        idBubblesRange.sort((a, b) => a.cx - b.cx);
        const idColsRaw = [];
        let curCol = [idBubblesRange[0]];
        for (let i = 1; i < idBubblesRange.length; i++) {
            if (idBubblesRange[i].cx - curCol[curCol.length - 1].cx < (area.w * 0.015)) {
                curCol.push(idBubblesRange[i]);
            } else {
                idColsRaw.push(curCol.sort((a, b) => a.cy - b.cy));
                curCol = [idBubblesRange[i]];
            }
        }
        idColsRaw.push(curCol.sort((a, b) => a.cy - b.cy));

        // En düzenli (en çok baloncuk içeren) 5 sütunu soldan sağa dizerek al
        const finalIdCols = idColsRaw
            .filter(c => c.length >= 7) // Eksik okuma payı ile en az 7-8 baloncuk olanları al
            .sort((a, b) => b.length - a.length)
            .slice(0, 5)
            .sort((a, b) => a[0].cx - b[0].cx);

        finalIdCols.forEach(col => {
            let foundDigit = "-";
            col.forEach((b, index) => {
                if (marked.includes(b)) {
                    foundDigit = index % 10;
                }
            });
            studentID += foundDigit;
        });
    }

    return { studentID: studentID || "-----", answers };
}

function displayResults(data) {
    elements.resId.innerText = data.studentID;
    elements.resCount.innerText = data.answers.filter(a => a.ans).length + " / 20";
    elements.answersGrid.innerHTML = '';
    data.answers.forEach(item => {
        const card = document.createElement('div');
        card.className = 'stat-card';
        card.innerHTML = `<div class="stat-label">Soru ${item.q}</div><div class="stat-value">${item.ans || '-'}</div>`;
        elements.answersGrid.appendChild(card);
    });
}

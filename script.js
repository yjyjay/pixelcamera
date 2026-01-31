const video = document.getElementById('video');
        const outputCanvas = document.getElementById('outputCanvas');
        const capturedImage = document.getElementById('captured-image'); // New Image Element
        const ctx = outputCanvas.getContext('2d');
        const shutter = document.getElementById('shutter');
        const loading = document.getElementById('loading');
        const captureBtn = document.getElementById('captureBtn');
        const resultActions = document.getElementById('resultActions');
        const retakeBtn = document.getElementById('retakeBtn');
        const downloadBtn = document.getElementById('downloadBtn');
        const resDisplay = document.getElementById('res-display');
        const dateDisplay = document.getElementById('date-display');
        const toast = document.getElementById('toast');

        let currentResolution = 128;
        let colorMode = '64'; 
        let ditherType = 'bayer'; 
        let isCaptured = false;
        let stream = null;
        let facingMode = 'user'; 

        // 임시 처리를 위한 오프스크린 캔버스
        const offscreenCanvas = document.createElement('canvas');
        const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

        // Blue Scale Palette (4 Colors)
        const paletteBlue = [
            [10, 25, 60],    // Deep Navy
            [40, 80, 140],   // Dark Blue
            [100, 160, 220], // Light Blue
            [210, 240, 255]  // Pale Blue
        ];

        // Arne16 Palette (Retro 16 colors)
        const palette16 = [
            [0, 0, 0], [157, 157, 157], [255, 255, 255], [190, 38, 51],
            [224, 111, 139], [73, 60, 43], [164, 100, 34], [235, 137, 49],
            [247, 226, 107], [47, 72, 78], [68, 137, 26], [163, 206, 39],
            [27, 38, 50], [0, 87, 132], [49, 162, 242], [178, 220, 239]
        ];

        // 4x4 Bayer Matrix
        const bayerMatrix = [
            [ 0,  8,  2, 10],
            [12,  4, 14,  6],
            [ 3, 11,  1,  9],
            [15,  7, 13,  5]
        ];

        // 2x2 Bayer Matrix (For Cleaner 4-Color Dithering)
        const bayerMatrix2x2 = [
            [0, 2],
            [3, 1]
        ];

        // --- Helper Functions ---

        function findClosestColor16(r, g, b) {
            let minDist = Infinity;
            let closest = palette16[0];
            for (let i = 0; i < palette16.length; i++) {
                const color = palette16[i];
                const dist = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
                if (dist < minDist) { minDist = dist; closest = color; }
            }
            return closest;
        }

        function getQuantizedColor(r, g, b) {
            r = Math.min(255, Math.max(0, r));
            g = Math.min(255, Math.max(0, g));
            b = Math.min(255, Math.max(0, b));

            if (colorMode === 'bw') {
                const brightness = (r + g + b) / 3;
                const val = brightness > 128 ? 255 : 0;
                return [val, val, val];
            } else if (colorMode === '4') {
                const brightness = (r + g + b) / 3;
                let level = Math.floor(brightness / 64);
                if (level > 3) level = 3;
                if (level < 0) level = 0;
                return paletteBlue[level];
            } else if (colorMode === '64') {
                r = Math.round(r / 85) * 85;
                g = Math.round(g / 85) * 85;
                b = Math.round(b / 85) * 85;
                return [r, g, b];
            } else if (colorMode === '128') {
                r = Math.round(r / 85) * 85;        // 4 levels
                g = Math.round(g / 36.43) * 36.43;  // 8 levels
                b = Math.round(b / 85) * 85;        // 4 levels
                return [r, g, b];
            } else {
                return findClosestColor16(r, g, b);
            }
        }

        function distributeError(buffer, x, y, errR, errG, errB, factor, width, height) {
            if (x < 0 || x >= width || y >= height) return;
            const idx = (y * width + x) * 4;
            buffer[idx] += errR * factor;
            buffer[idx + 1] += errG * factor;
            buffer[idx + 2] += errB * factor;
        }

        function processPixel(data, index, r, g, b) {
            const [finalR, finalG, finalB] = getQuantizedColor(r, g, b);
            data[index] = finalR;
            data[index + 1] = finalG;
            data[index + 2] = finalB;
        }

        function showToast(msg) {
            toast.innerText = msg;
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 3000);
        }

        // --- Main Logic ---

        function updateDate() {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            dateDisplay.innerText = `${year}-${month}-${day}`;
        }

        function setResolution(res) {
            currentResolution = res;
            document.querySelectorAll('[id^="btn-"][onclick^="setResolution"]').forEach(btn => btn.classList.remove('active-tab'));
            document.getElementById(`btn-${res}`).classList.add('active-tab');
            resDisplay.innerText = `${res}PX`;
            if (!isCaptured) renderPreview();
        }

        function setDitherType(type) {
            ditherType = type;
            document.getElementById('btn-dither-bayer').classList.toggle('active-tab', type === 'bayer');
            document.getElementById('btn-dither-error').classList.toggle('active-tab', type === 'error');
            if (!isCaptured) renderPreview();
        }

        function setColorMode(mode) {
            colorMode = mode;
            document.getElementById('btn-4c').classList.remove('active-tab');
            document.getElementById('btn-64c').classList.remove('active-tab');
            document.getElementById('btn-128c').classList.remove('active-tab');
            document.getElementById('btn-bw').classList.remove('active-tab');
            
            if (mode === '4') document.getElementById('btn-4c').classList.add('active-tab');
            else if (mode === '64') document.getElementById('btn-64c').classList.add('active-tab');
            else if (mode === '128') document.getElementById('btn-128c').classList.add('active-tab');
            else if (mode === 'bw') document.getElementById('btn-bw').classList.add('active-tab');

            if (!isCaptured) renderPreview();
        }

        async function startCamera() {
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
            }

            try {
                // facingMode 변수 사용
                stream = await navigator.mediaDevices.getUserMedia({ 
                    video: { facingMode: facingMode, width: { ideal: 500 }, height: { ideal: 500 } }, 
                    audio: false 
                });
                video.srcObject = stream;
                loading.classList.add('hidden');
                requestAnimationFrame(update);
            } catch (err) {
                console.error("Camera error:", err);
                loading.innerText = "NO SIGNAL";
                loading.style.color = "red";
            }
        }

        function toggleCamera() {
            facingMode = facingMode === 'user' ? 'environment' : 'user';
            startCamera();
        }

        function update() {
            if (!isCaptured) {
                renderPreview();
                requestAnimationFrame(update);
            }
        }

        function renderPreview() {
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                const size = Math.min(video.videoWidth, video.videoHeight);
                const startX = (video.videoWidth - size) / 2;
                const startY = (video.videoHeight - size) / 2;

                offscreenCanvas.width = currentResolution;
                offscreenCanvas.height = currentResolution;
                
                // 전면 카메라(user)일 경우 좌우 반전 처리
                offscreenCtx.save();
                if (facingMode === 'user') {
                    offscreenCtx.translate(currentResolution, 0);
                    offscreenCtx.scale(-1, 1);
                }
                
                offscreenCtx.drawImage(video, startX, startY, size, size, 0, 0, currentResolution, currentResolution);
                offscreenCtx.restore();

                const imageData = offscreenCtx.getImageData(0, 0, currentResolution, currentResolution);
                const data = imageData.data; 

                // Dithering Strategy Decision
                if (ditherType === 'bayer') {
                    for (let y = 0; y < currentResolution; y++) {
                        for (let x = 0; x < currentResolution; x++) {
                            const index = (y * currentResolution + x) * 4;
                            const threshold = (bayerMatrix[y % 4][x % 4] - 8) * 4; 

                            let r = data[index] + threshold;
                            let g = data[index + 1] + threshold;
                            let b = data[index + 2] + threshold;

                            processPixel(data, index, r, g, b);
                        }
                    }
                } else {
                    if (colorMode === '4') {
                        for (let y = 0; y < currentResolution; y++) {
                            for (let x = 0; x < currentResolution; x++) {
                                const index = (y * currentResolution + x) * 4;
                                const threshold = (bayerMatrix2x2[y % 2][x % 2] - 1.5) * 25;

                                let r = data[index] + threshold;
                                let g = data[index + 1] + threshold;
                                let b = data[index + 2] + threshold;

                                processPixel(data, index, r, g, b);
                            }
                        }
                    } else {
                        const width = currentResolution;
                        const height = currentResolution;
                        const buffer = new Float32Array(data); 

                        for (let y = 0; y < height; y++) {
                            for (let x = 0; x < width; x++) {
                                const idx = (y * width + x) * 4;
                                
                                const oldR = buffer[idx];
                                const oldG = buffer[idx + 1];
                                const oldB = buffer[idx + 2];

                                const [newR, newG, newB] = getQuantizedColor(oldR, oldG, oldB);
                                
                                data[idx] = buffer[idx] = newR;
                                data[idx+1] = buffer[idx+1] = newG;
                                data[idx+2] = buffer[idx+2] = newB;

                                const errR = oldR - newR;
                                const errG = oldG - newG;
                                const errB = oldB - newB;

                                distributeError(buffer, x + 1, y, errR, errG, errB, 7/16, width, height);
                                distributeError(buffer, x - 1, y + 1, errR, errG, errB, 3/16, width, height);
                                distributeError(buffer, x, y + 1, errR, errG, errB, 5/16, width, height);
                                distributeError(buffer, x + 1, y + 1, errR, errG, errB, 1/16, width, height);
                            }
                        }
                    }
                }

                offscreenCtx.putImageData(imageData, 0, 0);

                outputCanvas.width = 600;
                outputCanvas.height = 600;
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(offscreenCanvas, 0, 0, currentResolution, currentResolution, 0, 0, 600, 600);
            }
        }

        captureBtn.addEventListener('click', () => {
            isCaptured = true;
            shutter.classList.remove('opacity-0');
            shutter.classList.add('opacity-100');
            setTimeout(() => {
                shutter.classList.remove('opacity-100');
                shutter.classList.add('opacity-0');
            }, 100);
            
            // Convert Canvas to Image immediately for mobile save compatibility
            const dataUrl = outputCanvas.toDataURL('image/png');
            capturedImage.src = dataUrl;
            capturedImage.classList.remove('hidden');

            captureBtn.style.display = 'none'; 
            resultActions.classList.remove('hidden');
        });

        retakeBtn.addEventListener('click', () => {
            isCaptured = false;
            capturedImage.classList.add('hidden');
            capturedImage.src = ''; // Clear memory
            
            captureBtn.style.display = 'flex';
            resultActions.classList.add('hidden');
            requestAnimationFrame(update);
        });

        downloadBtn.addEventListener('click', () => {
            // Show toast for Google App users
            showToast("저장이 안 되면 화면을 길게 눌러주세요!");

            // Attempt standard download
            const link = document.createElement('a');
            link.download = `pixelshot-${currentResolution}px-${colorMode}-${ditherType}.png`;
            link.href = outputCanvas.toDataURL('image/png');
            link.click();
        });

        window.onload = () => {
            startCamera();
            updateDate();
        };

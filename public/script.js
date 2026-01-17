const socket = io();

// DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const queueCount = document.getElementById('queueCount');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('statusText');
const progressSection = document.getElementById('progressSection');
const galleryGrid = document.getElementById('galleryGrid');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const closeSettings = document.getElementById('closeSettings');
const saveSettings = document.getElementById('saveSettings');
const upscaylPathInput = document.getElementById('upscaylPath');
const enableUpscale = document.getElementById('enableUpscale');
const modelSelect = document.getElementById('modelSelect');

let uploadedFiles = [];

// Init
fetchConfig();
loadGallery();

// --- Event Listeners ---

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

processBtn.addEventListener('click', startProcessing);

settingsBtn.addEventListener('click', () => {
    fetchConfig();
    settingsModal.classList.remove('hidden');
});

closeSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));

saveSettings.addEventListener('click', async () => {
    const path = upscaylPathInput.value;
    if (path) {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        settingsModal.classList.add('hidden');
    }
});

// --- Functions ---

function handleFiles(files) {
    const formData = new FormData();
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        formData.append('images', file);
    }

    fetch('/api/upload', { method: 'POST', body: formData })
        .then(res => res.json())
        .then(data => {
            uploadedFiles = Array.from(files).map(f => f.name); // Simple tracking
            queueCount.textContent = `(${uploadedFiles.length} images)`;
            processBtn.disabled = false;
            statusText.textContent = `${data.count} images ready to process`;
            progressSection.hidden = false;
        });
}

function startProcessing() {
    processBtn.disabled = true;
    progressBar.style.width = '0%';

    // Trigger bulk process
    fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: 'all', // Process all in input folder
            settings: {
                upscale: enableUpscale.checked,
                model: modelSelect.value
            }
        })
    });
}

async function fetchConfig() {
    const res = await fetch('/api/config');
    const data = await res.json();
    upscaylPathInput.value = data.upscaylBin || '';

    // Show warning if Upscayl is not available
    if (!data.upscaylAvailable) {
        const warning = document.createElement('div');
        warning.style.cssText = 'background: #fbbf24; color: #000; padding: 1rem; margin-bottom: 1rem; border-radius: 0.5rem; text-align: center;';
        warning.innerHTML = '<strong>⚠️ Upscayl Not Found</strong><br>Upscaling will be skipped. Only optimization will be performed. <a href="https://upscayl.org" target="_blank" style="color: #000; text-decoration: underline;">Download Upscayl</a> or update the path in Settings.';
        document.querySelector('.app-container').insertBefore(warning, document.querySelector('main'));
    }
}

async function loadGallery() {
    const res = await fetch('/api/files');
    const files = await res.json();

    galleryGrid.innerHTML = files.map(file => `
        <div class="gallery-item">
            <a href="${file.url}" target="_blank">
                <img src="${file.url}" loading="lazy">
            </a>
            <div class="gallery-info">
                <span>${file.name}</span>
                <span>${file.size}</span>
            </div>
        </div>
    `).join('');
}

// --- Socket Events ---

socket.on('progress', (data) => {
    progressSection.hidden = false;

    if (data.type === 'start') {
        statusText.textContent = `Processing ${data.file}...`;
        progressBar.style.width = '10%';
    } else if (data.type === 'step') {
        statusText.textContent = `${data.file}: ${data.message}`;
        if (data.message.includes('Upscaling')) progressBar.style.width = '40%';
        if (data.message.includes('Optimizing')) progressBar.style.width = '70%';
    } else if (data.type === 'complete') {
        statusText.textContent = `Completed ${data.file}`;
        progressBar.style.width = '100%';
        loadGallery(); // Refresh gallery

        // Brief timeout to reset for next
        setTimeout(() => {
            progressBar.style.width = '0%';
        }, 1000);
    } else if (data.type === 'error') {
        statusText.textContent = `Error: ${data.message}`;
        statusText.style.color = '#ef4444';
    }
});

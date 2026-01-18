import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" }
});

const upload = multer({ dest: 'uploads/' });

// Directories
const DIRS = {
    input: path.join(__dirname, 'input'),
    output: path.join(__dirname, 'output'),
    temp: path.join(__dirname, 'temp'),
    uploads: path.join(__dirname, 'uploads')
};

// Ensure directories exist
Object.values(DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static('public'));
app.use('/output', express.static(DIRS.output));

// Default Upscayl path - can be overridden via API
let UPSCAYL_BIN = "C:\\Program Files\\Upscayl\\resources\\bin\\upscayl-bin.exe";
let MODELS_PATH = "C:\\Program Files\\Upscayl\\resources\\models";

// --- Routes ---

// Get current config
app.get('/api/config', (req, res) => {
    res.json({
        upscaylBin: UPSCAYL_BIN,
        upscaylAvailable: fs.existsSync(UPSCAYL_BIN)
    });
});

// Update config
app.post('/api/config', express.json(), (req, res) => {
    if (req.body.path) {
        UPSCAYL_BIN = req.body.path;
        // Try to deduce models path from bin path
        // Bin: .../resources/bin/upscayl-bin.exe
        // Models: .../resources/models
        const binDir = path.dirname(UPSCAYL_BIN);
        MODELS_PATH = path.join(path.dirname(binDir), 'models');
    }
    res.json({ success: true, upscaylBin: UPSCAYL_BIN, modelsPath: MODELS_PATH });
});

// List files in output
app.get('/api/files', (req, res) => {
    const files = fs.readdirSync(DIRS.output)
        .filter(f => /\.(jpg|png|jpeg)$/i.test(f))
        .map(f => ({
            name: f,
            url: `/output/${f}`,
            size: (fs.statSync(path.join(DIRS.output, f)).size / 1024 / 1024).toFixed(2) + ' MB'
        }));
    res.json(files);
});

// Handle Uploads
app.post('/api/upload', upload.array('images'), (req, res) => {
    req.files.forEach(file => {
        // Move to valid input directory with original name
        const targetPath = path.join(DIRS.input, file.originalname);
        fs.renameSync(file.path, targetPath);
    });
    res.json({ count: req.files.length });
});

// Process Image Endpoint
app.post('/api/process', express.json(), async (req, res) => {
    const { filename, settings } = req.body; // settings: { upscale: boolean, model: string }

    // We process all files in input if filename is 'all', otherwise specific file
    // For now simplistic 'process all in input' approach or single file

    try {
        const files = filename === 'all'
            ? fs.readdirSync(DIRS.input).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
            : [filename];

        res.json({ status: 'started', count: files.length });

        for (const file of files) {
            await processImage(file, settings);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const ARTIST = "Akhlaque"; // Customizable Identity

// Check if Upscayl is available
function isUpscaylAvailable() {
    return fs.existsSync(UPSCAYL_BIN);
}

async function processImage(fileName, settings) {
    const inputPath = path.join(DIRS.input, fileName);
    const tempUpscaledPath = path.join(DIRS.temp, fileName); // Intermediate step
    const finalOutputPath = path.join(DIRS.output, path.parse(fileName).name + ".jpg");

    io.emit('progress', { type: 'start', file: fileName });

    try {
        let currentPath = inputPath;

        // 1. Upscale if requested
        if (settings.upscale) {
            if (!isUpscaylAvailable()) {
                console.warn(`[${fileName}] Upscayl not found at ${UPSCAYL_BIN}. Skipping upscaling.`);
                io.emit('progress', {
                    type: 'step',
                    file: fileName,
                    message: '⚠️ Upscayl not found - skipping upscaling'
                });
            } else {
                io.emit('progress', { type: 'step', file: fileName, message: 'Upscaling...' });

                await new Promise((resolve, reject) => {
                    const args = [
                        '-i', inputPath,
                        '-o', tempUpscaledPath,
                        '-s', '4',
                        '-m', MODELS_PATH,
                        '-n', settings.model || 'upscayl-standard-4x',
                        '-f', 'png'
                    ];
                    console.log('Running Upscayl:', UPSCAYL_BIN, args.join(' '));
                    const child = spawn(UPSCAYL_BIN, args);
                    child.stderr.on('data', (data) => console.error(`[Upscayl]: ${data}`));
                    child.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Upscayl exited with code ${code}`));
                    });
                });
                currentPath = tempUpscaledPath;
            }
        }

        // 2. Process with Sharp (Metadata, sRGB, Format)
        io.emit('progress', { type: 'step', file: fileName, message: 'Optimizing & Tagging...' });

        // Log Metadata
        const originalMetadata = await sharp(currentPath).metadata();
        console.log(`[${fileName}] Original Metadata:`, JSON.stringify({
            format: originalMetadata.format,
            size: originalMetadata.size,
            density: originalMetadata.density,
            exif: originalMetadata.exif ? 'Present' : 'None',
            icc: originalMetadata.icc ? 'Present' : 'None'
        }, null, 2));

        // Processing Pipeline:
        // 1. Load image -> Rotate -> sRGB -> Buffer (This strips all metadata by default)
        // 2. Load Buffer -> Add Custom Metadata -> JPEG -> File

        const cleanBuffer = await sharp(currentPath)
            .rotate()
            .toColourspace('srgb')
            .toBuffer();

        await sharp(cleanBuffer)
            .withMetadata({
                exif: {
                    IFD0: {
                        Copyright: ARTIST,
                        Artist: ARTIST,
                        ImageDescription: fileName
                    }
                }
            })
            .jpeg({
                quality: 95,
                chromaSubsampling: '4:4:4',
                mozjpeg: true
            })
            .toFile(finalOutputPath);

        // Cleanup temp
        if (fs.existsSync(tempUpscaledPath)) fs.unlinkSync(tempUpscaledPath);

        // Delete input file after successful processing to prevent duplicates
        if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
            console.log(`[${fileName}] Deleted from input folder`);
        }

        io.emit('progress', { type: 'complete', file: fileName, output: `/output/${path.basename(finalOutputPath)}` });
        console.log(`[${fileName}] Processed & Tagged with identity: ${ARTIST}`);

    } catch (err) {
        console.error(`Error processing ${fileName}:`, err);
        io.emit('progress', { type: 'error', file: fileName, message: err.message });
    }
}

const PORT = 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Upscayl Bin: ${UPSCAYL_BIN}`);
});

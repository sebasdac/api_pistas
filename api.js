// api.js
// npm i express multer cors uuid @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { v4: uuid } = require("uuid");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffprobePath = require("@ffprobe-installer/ffprobe").path;

// ---- crea la app ANTES de usar app.post ----
const app = express();
app.use(cors());

// carpetas temporales y de salida pública
const tmpDir = path.join(os.tmpdir(), "vocalstrip_tmp");
const outDir = path.join(__dirname, "out");
fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// servir resultados estáticos en /out
app.use("/out", express.static(outDir, { maxAge: "1h" }));

const upload = multer({ dest: tmpDir });

app.get("/health", (_, res) => res.json({ ok: true }));

// ==== AÑADIDO: Inyecta ffmpeg/ffprobe y fuerza backend de torchaudio ====
(function ensureAudioTooling() {
  const ffDir = path.dirname(ffmpegPath);
  const fpDir = path.dirname(ffprobePath);
  const cur = process.env.PATH || "";
  process.env.PATH = [ffDir, fpDir, cur].filter(Boolean).join(path.delimiter);

  // Algunas libs respetan esto explícitamente:
  process.env.FFMPEG_BINARY = ffmpegPath;
  process.env.FFPROBE_BINARY = ffprobePath;

  // **Clave para tu error**: forzar torchaudio a usar soundfile/libsndfile
  process.env.TORCHAUDIO_USE_SOUNDFILE = "1";

  // (Opcional) habilitar backend ffmpeg de torchaudio si está disponible
  // process.env.TORCHAUDIO_USE_FFMPEG = "1";
})();

// util para Demucs: encuentra el "accompaniment"/"no_vocals"
function findAccompaniment(startDir) {
  const stack = [startDir];
  const re = /(no[_ ]?vocals|accompaniment|instrumental)\.wav$/i;
  while (stack.length) {
    const d = stack.pop();
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) stack.push(p);
      else if (re.test(name)) return p;
    }
  }
  return null;
}

// Asegura que el archivo tenga extensión recognoscible
function ensureExtForDemucs(srcPath, originalName) {
  let ext = (path.extname(originalName || "") || "").toLowerCase();
  if (!ext || ext === ".bin") ext = ".mp3"; // si no viene extensión, asumimos mp3
  const dstPath = srcPath + ext;
  try {
    fs.renameSync(srcPath, dstPath);
  } catch {
    fs.copyFileSync(srcPath, dstPath);
    try { fs.unlinkSync(srcPath); } catch {}
  }
  return dstPath;
}

// === Transcodifica a WAV PCM 16-bit 44.1kHz estéreo (robusto para torchaudio) ===
function transcodeToWav({ inputPath, wavPath }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-y",
      "-i", inputPath,
      "-vn",
      "-ac", "2",
      "-ar", "44100",
      "-sample_fmt", "s16",
      wavPath
    ];
    console.log("Pre-FFmpeg to WAV:\n", [ffmpegPath, ...args].join(" "));
    const ff = spawn(ffmpegPath, args, { windowsHide: true });
    let log = "";
    ff.stderr.on("data", d => { log += d.toString(); process.stdout.write(d.toString()); });
    ff.on("error", err => reject(new Error("ffmpeg spawn error: " + err)));
    ff.on("close", code => {
      if (code !== 0 || !fs.existsSync(wavPath)) {
        return reject(new Error("ffmpeg wav transcode failed:\n" + log.slice(-6000)));
      }
      resolve(true);
    });
  });
}

// wrapper FFmpeg "karaoke" (fallback rápido)
function runFfmpegKaraoke({ inputPath, outPath, keepBass, hp, onDone }) {
  const base = `aformat=channel_layouts=stereo`;
  const kara = `pan=stereo|c0=FL-FR|c1=FR-FL`;
  const chain = keepBass
    ? `${base},asplit=2[low][all];[low]lowpass=f=120,volume=1.2[lb];[all]${kara},highpass=f=${hp}[inst];[inst][lb]amix=inputs=2:duration=longest`
    : `${base},${kara},highpass=f=${hp}`;

  const args = [
    "-hide_banner",
    "-y",
    "-i", inputPath,
    "-map", "a:0",
    "-af", chain,
    "-c:a", "aac", "-b:a", "192k",
    outPath
  ];

  console.log("FFmpeg args:\n", [ffmpegPath, ...args].join(" "));
  const ff = spawn(ffmpegPath, args, { windowsHide: true });
  let stderr = "";
  ff.stderr.on("data", d => { const s = d.toString(); stderr += s; process.stdout.write(s); });
  ff.on("error", err => onDone({ ok:false, error:"ffmpeg spawn error", log:String(err) }));
  ff.on("close", code => {
    if (code !== 0 || !fs.existsSync(outPath)) {
      return onDone({ ok:false, error:"ffmpeg failed", log: stderr.slice(-6000) });
    }
    onDone({ ok:true });
  });
}

app.post("/process", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:"No file" });

    const engine = String(req.body.engine || "ffmpeg"); // "ffmpeg" | "demucs"

    const inputPath = req.file.path;
    const origName = (req.file.originalname || "input").replace(/\.[^.]+$/, "");
    const outName = `${origName}_instrumental_${uuid().slice(0,8)}.m4a`;
    const outPath = path.join(tmpDir, outName);

    if (engine === "demucs") {
      const demucsBin = process.env.DEMUCS_BIN || "demucs"; // o ruta a .venv\Scripts\demucs.exe
      const modelOut = path.join(tmpDir, "demucs_out");
      fs.mkdirSync(modelOut, { recursive:true });

      // 1) asegura extensión
      const demucsInput = ensureExtForDemucs(inputPath, req.file.originalname);
      // 2) pre-convierte a WAV PCM → torchaudio lo abre y (con soundfile) lo guarda
      const demucsWav = demucsInput.replace(/\.[^.]+$/, "") + "_demucs.wav";
      await transcodeToWav({ inputPath: demucsInput, wavPath: demucsWav });

      // modelo seleccionable (htdemucs, mdx_extra, mdx_extra_q, etc.)
      const model = String(req.body.model || "htdemucs");

      const dArgs = ["--two-stems=vocals", "-n", model, "-o", modelOut, demucsWav];
      console.log("Demucs cmd:", demucsBin, dArgs.join(" "));

      // Demucs heredará PATH + TORCHAUDIO_USE_SOUNDFILE=1 del proceso actual
      const dem = spawn(demucsBin, dArgs, {
        windowsHide: true,
        env: { ...process.env }
      });

      let dlog = "";
      dem.stdout.on("data", d => { dlog += d.toString(); process.stdout.write(d.toString()); });
      dem.stderr.on("data", d => { dlog += d.toString(); process.stdout.write(d.toString()); });

      dem.on("close", (code) => {
        try { fs.unlinkSync(demucsInput); } catch {}
        try { fs.unlinkSync(demucsWav); } catch {}
        if (code !== 0) {
          return res.status(500).json({ ok:false, error:"demucs failed", log:dlog.slice(-8000) });
        }
        const wav = findAccompaniment(modelOut);
        if (!wav) {
          return res.status(500).json({ ok:false, error:"no accompaniment file from demucs", log:dlog.slice(-8000) });
        }
        // Transcodifica WAV → M4A
        const args = ["-y","-i", wav, "-c:a","aac","-b:a","192k", outPath];
        const ff = spawn(ffmpegPath, args, { windowsHide:true });
        let flog = "";
        ff.stderr.on("data", d => { flog += d.toString(); process.stdout.write(d.toString()); });
        ff.on("close", (code2) => {
          if (code2 !== 0 || !fs.existsSync(outPath)) {
            return res.status(500).json({ ok:false, error:"ffmpeg transcode failed", log:flog.slice(-6000) });
          }
          const publicPath = path.join(outDir, outName);
          fs.rename(outPath, publicPath, err => {
            if (err) return res.status(500).json({ ok:false, error:String(err) });
            const baseUrl = process.env.SERVER_PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
            return res.json({ ok:true, downloadUrl: `${baseUrl}/out/${outName}` });
          });
        });
      });

      return; // importante
    }

    // --- Modo FFmpeg (rápido) ---
    const keepBass = String(req.body.keepBass ?? "true") === "true";
    const hp = Number(req.body.aggression ?? 140);

    runFfmpegKaraoke({
      inputPath, outPath, keepBass, hp,
      onDone: (result) => {
        try { fs.unlinkSync(inputPath); } catch {}
        if (!result.ok) {
          return res.status(500).json(result);
        }
        const publicPath = path.join(outDir, outName);
        fs.rename(outPath, publicPath, err => {
          if (err) return res.status(500).json({ ok:false, error:String(err) });
          const baseUrl = process.env.SERVER_PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
          return res.json({ ok:true, downloadUrl: `${baseUrl}/out/${outName}` });
        });
      }
    });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));

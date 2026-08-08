"""
Local STT (faster-whisper) + Piper TTS for hotline.guru.
Falls back to espeak-ng if Piper voice files are missing.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import uuid
import wave
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "tiny.en")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
SHARED = Path(os.environ.get("SHARED_DIR", "/shared"))
SHARED.mkdir(parents=True, exist_ok=True)

PIPER_MODEL = Path(
    os.environ.get("PIPER_MODEL", "/models/en_US-lessac-medium.onnx")
)
PIPER_CFG = Path(str(PIPER_MODEL) + ".json")

app = FastAPI(title="hotline.guru STT", version="0.2.0")

_model: WhisperModel | None = None
_piper = None


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        print(f"Loading faster-whisper {MODEL_NAME} on {DEVICE}/{COMPUTE}…")
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
        print("Model ready.")
    return _model


def get_piper():
    global _piper
    if _piper is not None:
        return _piper
    if not PIPER_MODEL.exists():
        print(f"Piper model missing at {PIPER_MODEL} — TTS will use espeak-ng")
        return None
    try:
        from piper import PiperVoice

        print(f"Loading Piper voice {PIPER_MODEL}…")
        _piper = PiperVoice.load(
            str(PIPER_MODEL),
            config_path=str(PIPER_CFG) if PIPER_CFG.exists() else None,
        )
        print("Piper ready.")
        return _piper
    except Exception as e:
        print(f"Piper load failed ({e}) — TTS will use espeak-ng")
        return None


def to_telephony_wav(src: Path, dest: Path) -> None:
    """Asterisk STREAM FILE expects 8 kHz mono PCM."""
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-ar",
            "8000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(dest),
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )


def synthesize_piper(text: str, out: Path) -> None:
    voice = get_piper()
    if voice is None:
        raise RuntimeError("piper unavailable")
    raw = out.with_suffix(".piper.wav")
    with wave.open(str(raw), "wb") as wf:
        voice.synthesize_wav(text, wf)
    try:
        to_telephony_wav(raw, out)
    finally:
        raw.unlink(missing_ok=True)


def synthesize_espeak(text: str, out: Path) -> None:
    raw = out.with_suffix(".raw.wav")
    try:
        subprocess.run(
            [
                "espeak-ng",
                "-v",
                "en-us",
                "-s",
                "140",
                "-w",
                str(raw),
                text,
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        to_telephony_wav(raw, out)
    finally:
        raw.unlink(missing_ok=True)


@app.on_event("startup")
def startup() -> None:
    get_model()
    get_piper()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "hotline-stt",
        "model": MODEL_NAME,
        "device": DEVICE,
        "tts": "piper" if get_piper() is not None else "espeak",
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty audio")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        path = tmp.name

    try:
        model = get_model()
        # Short IVR utterances (names) often vanish under VAD — try without first.
        segments, info = model.transcribe(
            path,
            language="en",
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        if not text and info.duration and info.duration > 0.4:
            segments, info = model.transcribe(
                path,
                language="en",
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        text = re.sub(r"\s+", " ", text)
        return {
            "ok": True,
            "text": text,
            "language": info.language,
            "duration": info.duration,
            "model": MODEL_NAME,
        }
    except Exception as e:
        raise HTTPException(500, f"transcribe failed: {e}") from e
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


@app.post("/tts")
async def tts(body: dict):
    """Synthesize speech → 8 kHz wav under SHARED (Asterisk STREAM FILE)."""
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    text = text[:280]
    safe = re.sub(r"[^a-zA-Z0-9 .,?!'$-]", " ", text)
    fid = body.get("id") or uuid.uuid4().hex[:12]
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", str(fid)):
        raise HTTPException(400, "invalid id")
    out = (SHARED / f"tts-{fid}.wav").resolve()
    if not str(out).startswith(str(SHARED.resolve())):
        raise HTTPException(400, "invalid path")
    try:
        if get_piper() is not None:
            synthesize_piper(safe, out)
        else:
            synthesize_espeak(safe, out)
    except FileNotFoundError as e:
        raise HTTPException(500, "espeak-ng or ffmpeg not installed") from e
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"").decode(errors="replace")
        raise HTTPException(500, f"tts failed: {err}") from e
    except Exception as e:
        raise HTTPException(500, f"tts failed: {e}") from e

    stem = str(out.with_suffix(""))
    return {
        "ok": True,
        "path": stem,
        "file": str(out),
        "id": fid,
        "engine": "piper" if get_piper() is not None else "espeak",
    }


@app.get("/tts/{fid}.wav")
def get_tts(fid: str):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", fid):
        raise HTTPException(400, "invalid id")
    path = (SHARED / f"tts-{fid}.wav").resolve()
    if not str(path).startswith(str(SHARED.resolve())) or not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/wav")

"""
Local STT (faster-whisper) + cheap TTS (espeak-ng) for hotline.guru.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "tiny.en")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
SHARED = Path(os.environ.get("SHARED_DIR", "/shared"))
SHARED.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="hotline.guru STT", version="0.1.0")

_model: WhisperModel | None = None


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        print(f"Loading faster-whisper {MODEL_NAME} on {DEVICE}/{COMPUTE}…")
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
        print("Model ready.")
    return _model


@app.on_event("startup")
def startup() -> None:
    get_model()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "hotline-stt",
        "model": MODEL_NAME,
        "device": DEVICE,
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
    """Synthesize speech with espeak-ng → wav under SHARED (Asterisk can STREAM FILE)."""
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text required")
    # Keep short for IVR
    text = text[:280]
    safe = re.sub(r"[^a-zA-Z0-9 .,?!'$-]", " ", text)
    fid = body.get("id") or uuid.uuid4().hex[:12]
    out = SHARED / f"tts-{fid}.wav"
    try:
        subprocess.run(
            [
                "espeak-ng",
                "-v",
                "en-us",
                "-s",
                "150",
                "-w",
                str(out),
                safe,
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
    except FileNotFoundError as e:
        raise HTTPException(500, "espeak-ng not installed") from e
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, f"espeak failed: {e.stderr.decode()}") from e

    # Asterisk STREAM FILE wants path without extension
    stem = str(out.with_suffix(""))
    return {"ok": True, "path": stem, "file": str(out), "id": fid}


@app.get("/tts/{fid}.wav")
def get_tts(fid: str):
    path = SHARED / f"tts-{fid}.wav"
    if not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="audio/wav")

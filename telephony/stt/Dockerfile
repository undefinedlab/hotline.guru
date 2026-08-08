FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Piper neural voice (lessac medium — natural US English, CPU-friendly)
RUN mkdir -p /models \
 && curl -fsSL -o /models/en_US-lessac-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx" \
 && curl -fsSL -o /models/en_US-lessac-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV WHISPER_MODEL=small.en
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE=int8
ENV SHARED_DIR=/shared
ENV PIPER_MODEL=/models/en_US-lessac-medium.onnx

EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]

FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV WHISPER_MODEL=tiny.en
ENV WHISPER_DEVICE=cpu
ENV WHISPER_COMPUTE=int8
ENV SHARED_DIR=/shared

EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]

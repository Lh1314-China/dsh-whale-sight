"""Audio event tagging for whale-sight.

Runs an AudioSet classifier (AST, 527 classes) over a handful of evenly spaced
windows of a WAV file and prints JSON on stdout:

    {"model": "...", "windows": [{"start": 0.0, "end": 10.0,
     "events": [{"label": "Speech", "score": 0.87}, ...]}, ...]}

The model is loaded from the local Hugging Face cache; set HF_ENDPOINT to a
mirror and HF_HOME to a writable cache directory before calling this script.
"""

import argparse
import json
import sys

import numpy as np
import soundfile as sf
from transformers import pipeline

MODEL = "MIT/ast-finetuned-audioset-10-10-0.4593"
SAMPLE_RATE = 16000
WINDOW_SECONDS = 10.0


def window_starts(start, span, count):
    """Evenly spread `count` window starts across a span."""
    if count <= 1:
        return [start]
    usable = max(0.0, span - WINDOW_SECONDS)
    return [start + usable * index / (count - 1) for index in range(count)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wav")
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=None)
    parser.add_argument("--windows", type=int, default=4)
    parser.add_argument("--topk", type=int, default=3)
    args = parser.parse_args()

    audio, sample_rate = sf.read(args.wav, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    duration = len(audio) / sample_rate

    start = max(0.0, args.start)
    end = duration if args.end is None else min(duration, args.end)
    if end <= start:
        end = duration
    span = max(1.0, end - start)
    count = max(1, min(args.windows, max(1, int(span // WINDOW_SECONDS) or 1)))

    classifier = pipeline("audio-classification", model=MODEL, device=-1)
    windows = []
    for window_start in window_starts(start, span, count):
        begin = int(window_start * sample_rate)
        stop = int(min(duration, window_start + WINDOW_SECONDS) * sample_rate)
        chunk = audio[begin:stop]
        if len(chunk) < SAMPLE_RATE:
            chunk = np.pad(chunk, (0, SAMPLE_RATE - len(chunk)))
        results = classifier({"raw": chunk, "sampling_rate": sample_rate}, top_k=args.topk)
        windows.append({
            "start": round(window_start, 2),
            "end": round(min(duration, window_start + WINDOW_SECONDS), 2),
            "events": [
                {"label": item["label"], "score": round(float(item["score"]), 4)}
                for item in results
            ],
        })

    json.dump({"model": MODEL, "windows": windows}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

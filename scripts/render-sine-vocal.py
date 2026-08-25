#!/usr/bin/env python3
"""Render a monophonic sine-wave trace of an isolated vocal recording.

The source recording is used only as control data. pYIN estimates the sung
fundamental and voicing confidence, while the short-time RMS supplies the
amplitude envelope. The output contains one continuously phase-advanced sine
oscillator and silence; no source audio is mixed back in.

Requires Python packages: librosa, numpy, scipy, soundfile.
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.signal import medfilt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=Path("public/audio/kids-vocals.mp3"),
    )
    parser.add_argument(
        "output",
        nargs="?",
        type=Path,
        default=Path("public/audio/kids-vocals-sine.mp3"),
    )
    parser.add_argument("--analysis-rate", type=int, default=16_000)
    parser.add_argument("--output-rate", type=int, default=48_000)
    parser.add_argument("--hop-ms", type=float, default=20)
    parser.add_argument("--fmin", type=float, default=65)
    parser.add_argument("--fmax", type=float, default=750)
    parser.add_argument("--peak", type=float, default=0.36)
    return parser.parse_args()


def repair_octave_errors(frequency: np.ndarray) -> np.ndarray:
    """Remove isolated octave slips without flattening bends or vibrato."""
    log_frequency = np.log2(frequency)
    local_median = medfilt(log_frequency, kernel_size=5)
    octave_delta = np.rint(log_frequency - local_median)
    is_octave_slip = (
        (np.abs(octave_delta) >= 1)
        & (np.abs((log_frequency - local_median) - octave_delta) < 0.18)
    )
    log_frequency[is_octave_slip] -= octave_delta[is_octave_slip]
    return np.exp2(log_frequency)


def smooth_envelope(target: np.ndarray, attack: float, release: float) -> np.ndarray:
    result = np.empty_like(target)
    value = 0.0
    for index, sample in enumerate(target):
        coefficient = attack if sample > value else release
        value += coefficient * (sample - value)
        result[index] = value
    return result


def render(args: argparse.Namespace) -> None:
    source, _ = librosa.load(args.input, sr=args.analysis_rate, mono=True)
    hop_length = max(1, round(args.analysis_rate * args.hop_ms / 1000))
    frame_length = 2048

    frequency, voiced, probability = librosa.pyin(
        source,
        fmin=args.fmin,
        fmax=args.fmax,
        sr=args.analysis_rate,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )
    rms = librosa.feature.rms(
        y=source,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )[0]

    frame_count = min(len(frequency), len(probability), len(rms))
    frequency = frequency[:frame_count]
    probability = np.nan_to_num(probability[:frame_count])
    voiced = voiced[:frame_count]
    rms = rms[:frame_count]

    known = np.flatnonzero(np.isfinite(frequency))
    if len(known) < 2:
        raise RuntimeError("The source did not contain enough pitched vocal audio")

    frame_index = np.arange(frame_count)
    continuous_frequency = np.interp(frame_index, known, frequency[known])
    continuous_frequency = repair_octave_errors(continuous_frequency)

    # Confidence controls the gate gradually. Brief weak frames retain a small
    # tail, but genuinely unvoiced speech becomes silence instead of noise.
    confidence = np.clip((probability - 0.18) / 0.62, 0, 1)
    confidence *= np.where(voiced, 1.0, 0.18)
    frame_amplitude = rms * confidence
    frame_amplitude = smooth_envelope(frame_amplitude, attack=0.62, release=0.20)

    active = frame_amplitude[frame_amplitude > 0]
    reference = np.percentile(active, 99.5) if len(active) else 1.0
    frame_amplitude = np.clip(frame_amplitude * (args.peak / reference), 0, args.peak)

    duration = len(source) / args.analysis_rate
    sample_count = round(duration * args.output_rate)
    sample_time = np.arange(sample_count) / args.output_rate
    frame_time = librosa.frames_to_time(
        np.arange(frame_count),
        sr=args.analysis_rate,
        hop_length=hop_length,
    )
    sample_frequency = np.interp(sample_time, frame_time, continuous_frequency)
    sample_amplitude = np.interp(sample_time, frame_time, frame_amplitude, left=0, right=0)

    phase = np.cumsum(2 * np.pi * sample_frequency / args.output_rate, dtype=np.float64)
    output = (np.sin(phase) * sample_amplitude).astype(np.float32)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="strood-sine-vocal-") as temp_dir:
        wav_path = Path(temp_dir) / "sine-vocal.wav"
        sf.write(wav_path, output, args.output_rate, subtype="FLOAT")
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(wav_path),
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "192k",
                str(args.output),
            ],
            check=True,
        )

    voiced_seconds = float(np.count_nonzero(frame_amplitude > args.peak * 0.01) * args.hop_ms / 1000)
    print(
        f"Rendered {duration:.3f}s to {args.output} with one sine oscillator "
        f"({voiced_seconds:.1f}s voiced, peak {float(np.max(np.abs(output))):.3f})."
    )


if __name__ == "__main__":
    render(parse_args())

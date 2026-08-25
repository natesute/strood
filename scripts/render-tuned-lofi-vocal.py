#!/usr/bin/env python3
"""Render a hard-tuned, reduced-resolution version of the aligned vocal stem.

The sung fundamental is snapped to the A-major / F-sharp-minor pitch set. A
formant-preserving, time-varying pitch shift flattens bends and vibrato while
leaving unvoiced consonants at their original pitch. The tuned result is then
cleanly band-limited through a 22.05 kHz resampling pass.

Requires Python packages: librosa, numpy, pedalboard, scipy, soundfile.
Also requires ffmpeg with the aresample filter.
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from pedalboard import time_stretch
from scipy.signal import medfilt


PITCH_CLASSES = np.array([1, 2, 4, 6, 8, 9, 11])  # C#, D, E, F#, G#, A, B


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
        default=Path("public/audio/kids-vocals-tuned-lofi.mp3"),
    )
    parser.add_argument("--analysis-rate", type=int, default=16_000)
    parser.add_argument("--output-rate", type=int, default=48_000)
    parser.add_argument("--hop-ms", type=float, default=10)
    parser.add_argument("--maximum-correction", type=float, default=2.0)
    parser.add_argument("--voicing-threshold", type=float, default=0.05)
    parser.add_argument("--target-rms-db", type=float, default=-17.5)
    parser.add_argument("--peak", type=float, default=0.82)
    return parser.parse_args()


def smooth_gate(target: np.ndarray, attack: float, release: float) -> np.ndarray:
    result = np.empty_like(target)
    value = 0.0
    for index, sample in enumerate(target):
        coefficient = attack if sample > value else release
        value += coefficient * (sample - value)
        result[index] = value
    return result


def smooth_curve(target: np.ndarray, coefficient: float) -> np.ndarray:
    result = np.empty_like(target)
    value = 0.0
    for index, sample in enumerate(target):
        value += coefficient * (sample - value)
        result[index] = value
    return result


def nearest_scale_note(midi: np.ndarray) -> np.ndarray:
    available = np.arange(24, 109)
    available = available[np.isin(available % 12, PITCH_CLASSES)]
    distances = np.abs(midi[:, np.newaxis] - available[np.newaxis, :])
    return available[np.argmin(distances, axis=1)].astype(float)


def pitch_correction_curve(
    source: np.ndarray,
    sample_rate: int,
    hop_ms: float,
    maximum_correction: float,
    voicing_threshold: float,
) -> tuple[np.ndarray, dict[str, float]]:
    hop_length = max(1, round(sample_rate * hop_ms / 1000))
    frequency, voiced, probability = librosa.pyin(
        source,
        fmin=65,
        fmax=750,
        sr=sample_rate,
        frame_length=2048,
        hop_length=hop_length,
        center=True,
    )
    probability = np.nan_to_num(probability)
    valid = np.isfinite(frequency) & voiced & (probability >= voicing_threshold)
    known = np.flatnonzero(valid)
    if len(known) < 2:
        raise RuntimeError("The source did not contain enough confidently pitched vocal audio")

    frame_index = np.arange(len(frequency))
    continuous_frequency = np.interp(frame_index, known, frequency[known])
    sung_midi = librosa.hz_to_midi(continuous_frequency)
    target_midi = nearest_scale_note(sung_midi)
    target_midi = medfilt(target_midi, kernel_size=5)
    correction = np.clip(target_midi - sung_midi, -maximum_correction, maximum_correction)

    # Every reliable sung frame is corrected completely. The short release
    # bridges tiny detector gaps while breaths and sibilants remain unshifted.
    confidence = smooth_gate(valid.astype(float), attack=0.85, release=0.35)
    correction *= confidence
    correction = medfilt(correction, kernel_size=3)
    correction = smooth_curve(correction, coefficient=0.65)

    frame_time = librosa.frames_to_time(
        frame_index,
        sr=sample_rate,
        hop_length=hop_length,
    )
    statistics = {
        "pitched_seconds": float(np.count_nonzero(valid) * hop_ms / 1000),
        "mean_correction": float(np.mean(np.abs(correction[valid]))),
        "maximum_correction": float(np.max(np.abs(correction))),
    }
    return np.column_stack((frame_time, correction)), statistics


def render(args: argparse.Namespace) -> None:
    original, _ = librosa.load(args.input, sr=args.output_rate, mono=True)
    analysis = librosa.resample(
        original,
        orig_sr=args.output_rate,
        target_sr=args.analysis_rate,
        res_type="soxr_hq",
    )
    correction_frames, statistics = pitch_correction_curve(
        analysis,
        args.analysis_rate,
        args.hop_ms,
        args.maximum_correction,
        args.voicing_threshold,
    )

    sample_time = np.arange(len(original), dtype=np.float64) / args.output_rate
    correction = np.interp(
        sample_time,
        correction_frames[:, 0],
        correction_frames[:, 1],
        left=0,
        right=0,
    )
    tuned = time_stretch(
        original.astype(np.float32),
        args.output_rate,
        stretch_factor=1.0,
        pitch_shift_in_semitones=correction,
        high_quality=True,
        transient_mode="crisp",
        transient_detector="soft",
        retain_phase_continuity=True,
        use_long_fft_window=False,
        use_time_domain_smoothing=False,
        preserve_formants=True,
    )[0]
    if len(tuned) < len(original):
        tuned = np.pad(tuned, (0, len(original) - len(tuned)))
    tuned = tuned[:len(original)]

    current_rms = float(np.sqrt(np.mean(np.square(tuned, dtype=np.float64))))
    target_rms = 10 ** (args.target_rms_db / 20)
    tuned *= target_rms / max(current_rms, np.finfo(float).eps)
    peak = float(np.max(np.abs(tuned)))
    if peak > args.peak:
        tuned *= args.peak / peak

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="strood-tuned-vocal-") as temp_dir:
        wav_path = Path(temp_dir) / "tuned-vocal.wav"
        sf.write(wav_path, tuned, args.output_rate, subtype="FLOAT")
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(wav_path),
                "-af",
                (
                    "highpass=f=90,"
                    "aresample=22050:filter_size=32,"
                    "aresample=48000:filter_size=16,"
                    "lowpass=f=9000,"
                    "loudnorm=I=-14:TP=-1.5:LRA=9"
                ),
                "-ar",
                str(args.output_rate),
                "-ac",
                "1",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "192k",
                str(args.output),
            ],
            check=True,
        )

    duration = len(original) / args.output_rate
    print(
        f"Rendered {duration:.3f}s to {args.output}; "
        f"corrected {statistics['pitched_seconds']:.1f}s of pitched vowels "
        f"by {statistics['mean_correction']:.2f} semitones on average "
        f"(maximum {statistics['maximum_correction']:.2f})."
    )


if __name__ == "__main__":
    render(parse_args())

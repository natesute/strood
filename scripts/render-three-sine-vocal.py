#!/usr/bin/env python3
"""Render sine-wave speech using three moving vocal-formant tones.

Praat's Burg analysis supplies F1, F2 and F3. Their local spectral magnitudes
and the recording's RMS envelope drive three phase-continuous oscillators. No
samples from the source recording are mixed into the result.

Requires Python packages: librosa, numpy, praat-parselmouth, scipy, soundfile.
"""

from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np
import parselmouth
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
        default=Path("public/audio/kids-vocals-3sine.mp3"),
    )
    parser.add_argument("--analysis-rate", type=int, default=16_000)
    parser.add_argument("--output-rate", type=int, default=48_000)
    parser.add_argument("--hop-ms", type=float, default=10)
    parser.add_argument("--target-rms-db", type=float, default=-17.5)
    parser.add_argument("--peak", type=float, default=0.62)
    return parser.parse_args()


def smooth_envelope(target: np.ndarray, attack: float, release: float) -> np.ndarray:
    result = np.empty_like(target)
    value = 0.0
    for index, sample in enumerate(target):
        coefficient = attack if sample > value else release
        value += coefficient * (sample - value)
        result[index] = value
    return result


def clean_formant(values: np.ndarray, lower: float, upper: float) -> np.ndarray:
    values = values.copy()
    values[(values < lower) | (values > upper)] = np.nan
    known = np.flatnonzero(np.isfinite(values))
    if len(known) < 2:
        raise RuntimeError(f"Could not recover a formant between {lower:g} and {upper:g} Hz")
    values = np.interp(np.arange(len(values)), known, values[known])
    return medfilt(values, kernel_size=5)


def spectral_trace(
    magnitude: np.ndarray,
    frequency: np.ndarray,
    sample_rate: int,
    fft_size: int,
) -> np.ndarray:
    bin_position = np.clip(frequency * fft_size / sample_rate, 0, magnitude.shape[0] - 1.001)
    lower = np.floor(bin_position).astype(int)
    blend = bin_position - lower
    frames = np.arange(len(frequency))
    return magnitude[lower, frames] * (1 - blend) + magnitude[lower + 1, frames] * blend


def render(args: argparse.Namespace) -> None:
    source, _ = librosa.load(args.input, sr=args.analysis_rate, mono=True)
    hop_length = max(1, round(args.analysis_rate * args.hop_ms / 1000))
    fft_size = 1024
    frame_length = 1024

    magnitude = np.abs(librosa.stft(
        source,
        n_fft=fft_size,
        hop_length=hop_length,
        win_length=400,
        window="hann",
        center=True,
        dtype=np.complex64,
    ))
    rms = librosa.feature.rms(
        y=source,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )[0]
    frame_count = min(magnitude.shape[1], len(rms))
    magnitude = magnitude[:, :frame_count]
    rms = rms[:frame_count]
    frame_time = librosa.frames_to_time(
        np.arange(frame_count),
        sr=args.analysis_rate,
        hop_length=hop_length,
    )

    sound = parselmouth.Sound(source, sampling_frequency=args.analysis_rate)
    formant_model = sound.to_formant_burg(
        time_step=args.hop_ms / 1000,
        max_number_of_formants=5,
        maximum_formant=5_500,
        window_length=0.025,
        pre_emphasis_from=50,
    )
    raw_formants = [
        np.array([
            formant_model.get_value_at_time(number, min(max(time, 0), sound.duration))
            for time in frame_time
        ])
        for number in (1, 2, 3)
    ]
    formants = [
        clean_formant(raw_formants[0], 180, 1_100),
        clean_formant(raw_formants[1], 650, 3_200),
        clean_formant(raw_formants[2], 1_500, 5_200),
    ]
    formants[1] = np.maximum(formants[1], formants[0] + 220)
    formants[2] = np.maximum(formants[2], formants[1] + 280)

    noise_floor = np.percentile(rms, 20) * 1.35
    full_voice = np.percentile(rms, 88)
    voice_envelope = np.clip((rms - noise_floor) / (full_voice - noise_floor), 0, 1)
    voice_envelope = np.power(voice_envelope, 0.58)
    voice_envelope = smooth_envelope(voice_envelope, attack=0.68, release=0.12)

    weights = (1.0, 0.72, 0.52)
    control_amplitudes = []
    reference_frames = rms > np.percentile(rms, 35)
    for frequency, weight in zip(formants, weights):
        energy = spectral_trace(magnitude, frequency, args.analysis_rate, fft_size)
        reference = np.percentile(energy[reference_frames], 97)
        colour = np.clip(energy / max(reference, np.finfo(float).eps), 0, 1)
        amplitude = voice_envelope * weight * (0.32 + 0.68 * np.sqrt(colour))
        control_amplitudes.append(smooth_envelope(amplitude, attack=0.72, release=0.16))

    duration = len(source) / args.analysis_rate
    sample_count = round(duration * args.output_rate)
    sample_time = np.arange(sample_count) / args.output_rate
    output = np.zeros(sample_count, dtype=np.float32)
    for frequency, amplitude in zip(formants, control_amplitudes):
        sample_frequency = np.interp(sample_time, frame_time, frequency)
        sample_amplitude = np.interp(sample_time, frame_time, amplitude, left=0, right=0)
        phase = np.cumsum(2 * np.pi * sample_frequency / args.output_rate, dtype=np.float64)
        output += (np.sin(phase) * sample_amplitude).astype(np.float32)

    current_rms = float(np.sqrt(np.mean(np.square(output, dtype=np.float64))))
    target_rms = 10 ** (args.target_rms_db / 20)
    output *= target_rms / max(current_rms, np.finfo(float).eps)
    peak = float(np.max(np.abs(output)))
    if peak > args.peak:
        output *= args.peak / peak

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="strood-three-sine-vocal-") as temp_dir:
        wav_path = Path(temp_dir) / "three-sine-vocal.wav"
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

    active_seconds = float(np.count_nonzero(voice_envelope > 0.01) * args.hop_ms / 1000)
    final_rms = 20 * np.log10(max(float(np.sqrt(np.mean(np.square(output, dtype=np.float64)))), 1e-12))
    final_peak = 20 * np.log10(max(float(np.max(np.abs(output))), 1e-12))
    print(
        f"Rendered {duration:.3f}s to {args.output} with three formant sines "
        f"({active_seconds:.1f}s active, RMS {final_rms:.1f} dBFS, peak {final_peak:.1f} dBFS)."
    )


if __name__ == "__main__":
    render(parse_args())

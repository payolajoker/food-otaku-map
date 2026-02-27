#!/usr/bin/env python3
"""Capture exact YouTube frames at place timestamps.

This script uses:
1) `yt-dlp` to resolve a direct video stream URL per video ID.
2) `ffmpeg` (from imageio-ffmpeg) to grab one frame at each timestamp.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import imageio_ffmpeg


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        default="web/data/places.json",
        help="Path to places.json",
    )
    parser.add_argument(
        "--output-dir",
        default="web/assets/frames",
        help="Directory where frame images are saved",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-capture even when frame file already exists",
    )
    return parser.parse_args()


def run_checked(command: list[str]) -> str:
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def download_video(video_id: str, output_file: Path, ffmpeg_path: str, force: bool) -> Path:
    if output_file.exists() and not force:
        return output_file

    watch_url = f"https://www.youtube.com/watch?v={video_id}"
    command = [
        "yt-dlp",
        "--no-playlist",
        "--force-overwrites",
        "-f",
        "best[ext=mp4][height<=480]/best[height<=480]",
        "-o",
        str(output_file),
        watch_url,
    ]
    environment = dict(os.environ)
    environment["FFMPEG_LOCATION"] = ffmpeg_path
    subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    if not output_file.exists():
        raise RuntimeError(f"Failed to download video {video_id}")
    return output_file


def create_frame(ffmpeg_path: str, input_video: Path, seconds: int, output_file: Path) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        str(seconds),
        "-i",
        str(input_video),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_file),
    ]
    subprocess.run(command, check=True)
    if not output_file.exists() or output_file.stat().st_size < 1024:
        raise RuntimeError(f"Frame output looks invalid: {output_file}")


def main() -> None:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    input_path = (repo_root / args.input).resolve()
    output_dir = (repo_root / args.output_dir).resolve()
    web_root = (repo_root / "web").resolve()

    places = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(places, list):
        raise RuntimeError("places.json must contain a JSON array")

    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    temp_cache_dir = Path(tempfile.mkdtemp(prefix="food-otaku-map-frames-"))
    video_cache: dict[str, Path] = {}
    captured_count = 0
    skipped_count = 0

    try:
        for place in places:
            video_id = str(place.get("youtubeId") or "").strip()
            start = place.get("youtubeStart")
            if not video_id or not isinstance(start, (int, float)):
                continue

            seconds = int(start)
            file_name = f"{video_id}_{seconds:05d}.jpg"
            output_file = output_dir / file_name
            relative = "./" + output_file.relative_to(web_root).as_posix()
            place["youtubeFrameImage"] = relative

            if output_file.exists() and not args.force:
                skipped_count += 1
                print(f"[skip] {video_id} @ {seconds}s -> {relative}")
                continue

            if video_id not in video_cache:
                video_file = temp_cache_dir / f"{video_id}.mp4"
                video_cache[video_id] = download_video(video_id, video_file, ffmpeg_path, args.force)

            create_frame(ffmpeg_path, video_cache[video_id], seconds, output_file)
            captured_count += 1
            print(f"[ok] {video_id} @ {seconds}s -> {relative}")
    finally:
        shutil.rmtree(temp_cache_dir, ignore_errors=True)

    input_path.write_text(json.dumps(places, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Done. Captured: {captured_count}, skipped: {skipped_count}, videos: {len(video_cache)}")


if __name__ == "__main__":
    main()

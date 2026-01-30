#!/usr/bin/env bash
set -e

# install node deps
npm install

# install static ffmpeg binary
mkdir -p /opt/ffmpeg
cd /opt/ffmpeg

curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o ffmpeg.tar.xz
tar -xf ffmpeg.tar.xz
cp ffmpeg-*/ffmpeg /usr/local/bin/ffmpeg

ffmpeg -version

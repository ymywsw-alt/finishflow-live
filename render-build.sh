#!/usr/bin/env bash
set -e

# Install deps
npm install

# Install ffmpeg (Render Debian/Ubuntu base)
apt-get update
apt-get install -y ffmpeg

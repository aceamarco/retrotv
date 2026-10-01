#!/bin/sh
# Build the APK in Docker, so the host needs no JDK or Android SDK.
# The named volumes keep Gradle's cache and the debug signing key between
# builds; reusing the key is what lets a new build install over the old one.
set -e
cd "$(dirname "$0")"
docker run --rm --platform linux/amd64 \
  -v "$PWD":/project -w /project \
  -v retrotv-gradle:/root/.gradle -v retrotv-android:/root/.android \
  ghcr.io/cirruslabs/android-sdk:35 ./gradlew --no-daemon assembleDebug "$@"
echo "APK: $PWD/app/build/outputs/apk/debug/app-debug.apk"

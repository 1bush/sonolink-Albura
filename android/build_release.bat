@echo off
cd /d %~dp0
call gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64 > build_release.log 2>&1
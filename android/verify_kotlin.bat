@echo off
cd /d %~dp0
call gradlew.bat :expo-crypto:compileReleaseKotlin --no-build-cache > verify_kotlin.log 2>&1
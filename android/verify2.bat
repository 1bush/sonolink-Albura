@echo off
cd /d %~dp0
call gradlew.bat :expo-image-manipulator:compileReleaseKotlin > verify2.log 2>&1
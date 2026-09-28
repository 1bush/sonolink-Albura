@echo off
echo ===================================================
echo   SonoLink APK Generator (Fix for Android Studio)
echo ===================================================
echo.
echo Pastrohen variablat e konfliktit...
set ANDROID_PREFS_ROOT=
set ANDROID_USER_HOME=

echo Duke gjeneruar APK-ne release...
call gradlew assembleRelease

if %ERRORLEVEL% equ 0 (
    echo.
    echo ===================================================
    echo   SUCCESS! APK u gjenerua me sukses.
    echo ===================================================
    echo Skedari ndodhet te:
    echo app\build\outputs\apk\release\app-release.apk
    echo.
    explorer app\build\outputs\apk\release\
) else (
    echo.
    echo ===================================================
    echo   ERROR: Build-i dështoi. Shiko gabimet më lart.
    echo ===================================================
)
pause

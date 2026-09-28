@echo off
setlocal
set JAVA_HOME=C:\Users\roven\.jdks\jbr-17.0.14
cd /d C:\Users\roven\Desktop\sonolink-mobile\android
echo [%date% %time%] Nisi build-i SonoLink+Drita >> ..\build-drita-apk.log
call gradlew.bat assembleDebug --no-daemon >> ..\build-drita-apk.log 2>&1
echo [%date% %time%] Build mbaroi me kod %errorlevel% >> ..\build-drita-apk.log
endlocal

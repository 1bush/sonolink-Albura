@echo off
cd /d C:\Users\roven\Desktop\sonolink-mobile
echo === TSC CHECK === > build-chain.log
call npx.cmd tsc --noEmit >> build-chain.log 2>&1
echo TSC_EXIT_%ERRORLEVEL% >> build-chain.log
cd android
echo === GRADLE START === > ..\gradle-build.log
call gradlew.bat --no-daemon assembleRelease assembleDebug >> ..\gradle-build.log 2>&1
echo DONE_EXIT_%ERRORLEVEL% >> ..\gradle-build.log

@echo off
setlocal
set DIR=%~dp0
if exist "%DIR%\gradle\wrapper\gradle-wrapper.jar" goto jar_ok
echo Gradle wrapper JAR not found. Please add gradle-wrapper.jar to gradle\wrapper.
exit /b 1
:jar_ok
set CLASSPATH=%DIR%\gradle\wrapper\gradle-wrapper.jar;%DIR%\gradle\wrapper\gradle-wrapper-shared-8.5.jar;%DIR%\gradle\wrapper\gradle-cli-8.5.jar
java -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*

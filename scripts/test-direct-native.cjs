const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const javaHome = process.env.JAVA_HOME || (process.platform === 'win32' ? 'C:/Program Files/Java/jdk-17' : '');
const exe = name => javaHome ? path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const output = path.join(root, 'android/build/direct-control-tests');
const native = path.join(root, 'android/app/src/main/java/com/anonymous/kelakonnect');
fs.mkdirSync(output, { recursive: true });
execFileSync(exe('javac'), ['-d', output, path.join(native, 'DirectControlSocket.java'),
  path.join(native, 'DirectLinkHealth.java'), path.join(__dirname, 'DirectControlSocketTest.java')], { stdio: 'inherit', timeout: 30000 });
execFileSync(exe('java'), ['-cp', output, 'com.anonymous.kelakonnect.DirectControlSocketTest'], { stdio: 'inherit', timeout: 30000 });

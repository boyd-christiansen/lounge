import {execFileSync} from 'node:child_process';
import {mkdirSync,cpSync,copyFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
if(process.platform!=='darwin')throw new Error('Lounge.app builds on macOS.');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),bundle=resolve(root,'dist/Lounge.app');
// Only public application code/dependencies are packaged. Never copy data, .env,
// provider profiles, home directories or repository metadata into the app.
rmSync(bundle,{recursive:true,force:true});
const executable=join(bundle,'Contents/MacOS'),resources=join(bundle,'Contents/Resources/app');
mkdirSync(executable,{recursive:true});mkdirSync(resources,{recursive:true});
for(const directory of ['lib','public','node_modules'])cpSync(join(root,directory),join(resources,directory),{recursive:true,verbatimSymlinks:true});
for(const file of ['server.mjs','package.json','package-lock.json'])copyFileSync(join(root,file),join(resources,file));
const libraries=execFileSync('otool',['-L',process.execPath],{encoding:'utf8'}).split('\n').slice(1).map(line=>line.trim().split(' ')[0]).filter(Boolean);
if(libraries.some(path=>!path.startsWith('/usr/lib/')&&!path.startsWith('/System/Library/')))throw new Error('The selected Node binary has non-system dependencies. Use a standalone official Node distribution.');
copyFileSync(process.execPath,join(executable,'node'));
const iconset=join(root,'dist/Lounge.iconset');mkdirSync(iconset,{recursive:true});
for(const size of [16,32,128,256,512])for(const scale of [1,2]){
  const pixels=String(size*scale),name=`icon_${size}x${size}${scale===2?'@2x':''}.png`;
  execFileSync('sips',['-z',pixels,pixels,join(root,'public/assets/lounge-icon.png'),'--out',join(iconset,name)],{stdio:'ignore'});
}
execFileSync('iconutil',['-c','icns',iconset,'-o',join(bundle,'Contents/Resources/Lounge.icns')]);
rmSync(iconset,{recursive:true,force:true});
writeFileSync(join(bundle,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.commandlounge.app</string><key>CFBundleName</key><string>Lounge</string><key>CFBundleDisplayName</key><string>Lounge</string><key>CFBundleExecutable</key><string>Lounge</string><key>CFBundleIconFile</key><string>Lounge.icns</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.4.0</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSMicrophoneUsageDescription</key><string>Dictate complete thoughts to Lounge.</string><key>NSAccessibilityUsageDescription</key><string>Control existing conversations in the Claude app.</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);
execFileSync('xcrun',['swiftc','-O','-module-cache-path','/private/tmp/command-lounge-swift-cache',join(root,'native/DesktopBridge.swift'),join(root,'native/LoungeApp.swift'),'-o',join(executable,'Lounge')],{stdio:'inherit'});
execFileSync('codesign',['--force','--sign','-',join(executable,'node')],{stdio:'inherit'});
execFileSync('codesign',['--force','--deep','--sign','-','--identifier','local.commandlounge.app',bundle],{stdio:'inherit'});
execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
console.log(`Built ${bundle}. Queue data and credentials are outside the bundle.`);

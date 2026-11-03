import Foundation
import AppKit
import WebKit

final class LoungeApplication: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var backend: Process?
    var backendInput: FileHandle?
    var received = Data()
    var port = 4317
    var quitting = false
    let bridgeQueue = DispatchQueue(label: "local.commandlounge.desktop", qos: .userInitiated)
    let writeLock = NSLock()
    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--port"), arguments.count > index + 1, let value = Int(arguments[index+1]), value > 1024 && value < 65536 { port = value }
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("Command Lounge")
        var state = applicationSupport
        if let index = arguments.firstIndex(of: "--verification-state"), arguments.count > index + 1, arguments[index+1].hasPrefix("/private/tmp/") { state = URL(fileURLWithPath: arguments[index+1]) }
        do { try FileManager.default.createDirectory(at: state.appendingPathComponent("workspace"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { showError("Lounge could not open its local data directory."); return }
        let menu = NSMenu(), appMenu = NSMenu(), item = NSMenuItem()
        appMenu.addItem(withTitle: "About Lounge", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(NSMenuItem.separator()); appMenu.addItem(withTitle: "Quit Lounge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu=appMenu;menu.addItem(item)
        let edit = NSMenu(title:"Edit");for (title,action,key) in [("Undo","undo:","z"),("Redo","redo:","Z"),("Cut","cut:","x"),("Copy","copy:","c"),("Paste","paste:","v"),("Select All","selectAll:","a")] { edit.addItem(withTitle:title,action:Selector(action),keyEquivalent:key) }
        let editItem=NSMenuItem();editItem.submenu=edit;menu.addItem(editItem);NSApp.mainMenu=menu
        let configuration=WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback=[]
        configuration.userContentController.add(self,name:"loungeShell")
        web=WKWebView(frame:.zero,configuration:configuration);web.navigationDelegate=self;web.uiDelegate=self
        web.setValue(false,forKey:"drawsBackground")
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1380,height:900),styleMask:[.titled,.closable,.miniaturizable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title="Lounge";window.titleVisibility = .hidden;window.titlebarAppearsTransparent=true;window.backgroundColor=NSColor(white:0.08,alpha:1)
        window.collectionBehavior=[.fullScreenPrimary];window.minSize=NSSize(width:720,height:560);window.contentView=web;window.center();window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        startBackend(state)
    }
    func startBackend(_ state: URL) {
        let bundle=Bundle.main.bundleURL
        let code=bundle.appendingPathComponent("Contents/Resources/app")
        let process=Process();process.executableURL=bundle.appendingPathComponent("Contents/MacOS/node");process.arguments=["--disable-warning=ExperimentalWarning",code.appendingPathComponent("server.mjs").path];process.currentDirectoryURL=state.appendingPathComponent("workspace")
        var environment=ProcessInfo.processInfo.environment
        for name in ["NODE_OPTIONS","NODE_PATH","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","DYLD_FRAMEWORK_PATH"] { environment.removeValue(forKey:name) }
        environment["LOUNGE_DESKTOP_HOST"]="1";environment["LOUNGE_DB"]=state.appendingPathComponent("lounge.sqlite").path
        environment["LOUNGE_ENV_FILE"]=state.appendingPathComponent("private.env").path;environment["LOUNGE_WORKSPACE"]=state.appendingPathComponent("workspace").path;environment["PORT"]=String(port)
        environment["PATH"]="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:"+(environment["PATH"] ?? "")
        let codex="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
        if FileManager.default.isExecutableFile(atPath:codex) { environment["CODEX_BIN"]=codex }
        process.environment=environment
        let output=Pipe(),input=Pipe(),errors=Pipe();process.standardOutput=output;process.standardInput=input;process.standardError=errors;backendInput=input.fileHandleForWriting
        errors.fileHandleForReading.readabilityHandler={ handle in _=handle.availableData }
        output.fileHandleForReading.readabilityHandler={ [weak self] handle in
            let data=handle.availableData;if data.isEmpty { return }
            DispatchQueue.main.async { self?.receive(data) }
        }
        process.terminationHandler={ [weak self] _ in DispatchQueue.main.async { guard let self=self,!self.quitting else{return};self.showError("The local service stopped. Your saved queue is retained. Close any other Lounge instance, then reopen Lounge.") } }
        do { try process.run();backend=process } catch { showError("The bundled local runtime could not start.") }
    }
    func receive(_ data: Data) {
        received.append(data)
        while let newline=received.firstIndex(of:10) {
            let line=received[..<newline];received.removeSubrange(...newline)
            guard let message=(try? JSONSerialization.jsonObject(with:Data(line))) as? [String:Any],let kind=message["kind"] as? String else {continue}
            if kind=="server.ready" { web.load(URLRequest(url:URL(string:"http://127.0.0.1:\(port)/")!)) }
            if kind=="desktop.request" {
                guard let method=message["method"] as? String,["status","requestPermission","inspect","act","reveal","setEnabled","openClaudeCode"].contains(method) else {continue}
                var request=message;request.removeValue(forKey:"kind")
                guard let encoded=try? JSONSerialization.data(withJSONObject:request),let text=String(data:encoded,encoding:.utf8) else {continue}
                let work={ [weak self] in
                    let response=bridgeReply(text)
                    guard var body=(try? JSONSerialization.jsonObject(with:Data(response.utf8))) as? [String:Any] else{return}
                    body["kind"]="desktop.response"
                    if let bytes=try? JSONSerialization.data(withJSONObject:body) { self?.writeLock.lock();self?.backendInput?.write(bytes+Data([10]));self?.writeLock.unlock() }
                }
                if method=="requestPermission" { work() } else { bridgeQueue.async(execute:work) }
            }
        }
    }
    @objc func openSettings() { web?.evaluateJavaScript("document.dispatchEvent(new CustomEvent('lounge:settings'))", completionHandler:nil) }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,message.frameInfo.securityOrigin.host=="127.0.0.1",message.frameInfo.securityOrigin.port==port,
              let body=message.body as? [String:String] else {return}
        if body["action"]=="fullscreen" {window.toggleFullScreen(nil)}
        if body["action"]=="openClaude",let url=NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.anthropic.claudefordesktop") {NSWorkspace.shared.openApplication(at:url,configuration:NSWorkspace.OpenConfiguration(),completionHandler:nil)}
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        guard let url=navigationAction.request.url else{decisionHandler(.cancel);return}
        if url.scheme=="about" || (url.scheme=="http"&&url.host=="127.0.0.1"&&url.port==port) {decisionHandler(.allow);return}
        if navigationAction.navigationType == .linkActivated { openExternal(url) };decisionHandler(.cancel)
    }
    func webView(_ webView:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,for navigationAction:WKNavigationAction,windowFeatures:WKWindowFeatures)->WKWebView? {
        if let url=navigationAction.request.url {openExternal(url)};return nil
    }
    func openExternal(_ url:URL) {if ["https","http","codex"].contains(url.scheme ?? "") {NSWorkspace.shared.open(url)}}
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool {window?.makeKeyAndOrderFront(nil);return true}
    func applicationWillTerminate(_ notification:Notification) {quitting=true;backendInput?.closeFile();backend?.terminate()}
    func showError(_ text:String) {let alert=NSAlert();alert.messageText="Lounge needs attention";alert.informativeText=text;alert.runModal()}
}
@main struct LoungeMain {static func main(){let application=NSApplication.shared;let delegate=LoungeApplication();application.delegate=delegate;application.setActivationPolicy(.regular);application.run()}}

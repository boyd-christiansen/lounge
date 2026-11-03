import Foundation
import AppKit
import ApplicationServices

// The transport is shared; each application needs an explicit driver and allowlist
// entry. This first implementation can address Claude only.
let allowedApps = ["claude": "com.anthropic.claudefordesktop"]
var handles: [String: AXUIElement] = [:]
var handleLabels: [String: String] = [:]
var snapshotContext = ""
var snapshotApp = ""
var bridgeControlEnabled = false

struct BridgeError: Error {
    let code: String
    let message: String
}
func fail(_ code: String, _ message: String) throws -> Never { throw BridgeError(code: code, message: message) }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let text = value as? String { return text }
    if let url = value as? URL { return url.absoluteString }
    if let number = value as? NSNumber { return number.stringValue }
    return ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    return attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}
func label(_ element: AXUIElement) -> String {
    [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute].map { string(element, $0) }.joined(separator: "\u{1f}")
}
func application(_ key: String) throws -> NSRunningApplication {
    guard let bundle = allowedApps[key] else { try fail("unsupported_app", "No desktop driver is enabled for this application.") }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { try fail("app_closed", "Open Claude Desktop before connecting.") }
    return app
}
func permission() -> Bool { AXIsProcessTrusted() }
func requirePermission() throws { if !permission() { try fail("accessibility_required", "Desktop control needs macOS Accessibility permission.") } }

func inspect(_ key: String, retain: Bool = true) throws -> [String: Any] {
    try requirePermission()
    let app = try application(key), root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    guard let window = attribute(root, kAXFocusedWindowAttribute) else { try fail("window_unavailable", "Claude has no accessible focused window.") }
    let focusedWindow = window as! AXUIElement
    var nodes: [[String: Any]] = [], urls: [String] = []
    let generation = UUID().uuidString
    var nextHandles: [String: AXUIElement] = [:], nextLabels: [String: String] = [:]
    var clipped = false, totalText = 0
    func visit(_ element: AXUIElement, _ parent: String?, _ depth: Int) {
        if nodes.count >= 3000 || depth > 45 || totalText > 160000 { clipped = true; return }
        let role = string(element, kAXRoleAttribute), description = string(element, kAXDescriptionAttribute)
        // Authentication and password controls are never inspected or actionable.
        if role == "AXSecureTextField" || description.lowercased().contains("password") { return }
        let id = generation + ":" + String(nodes.count), title = string(element, kAXTitleAttribute)
        let url = string(element, kAXURLAttribute)
        if role == "AXWebArea" && !url.isEmpty { urls.append(url) }
        let rawValue = string(element, kAXValueAttribute)
        let valueLimit = ["AXTextArea", "AXTextField"].contains(role) ? 100000 : 6000
        let value = String(rawValue.prefix(valueLimit))
        totalText += title.count + description.count + value.count
        var node: [String: Any] = ["id": id, "role": role, "title": String(title.prefix(1000)), "description": String(description.prefix(1000)), "value": value]
        let placeholder = string(element, "AXPlaceholderValue")
        if !placeholder.isEmpty { node["placeholder"] = placeholder }
        if rawValue.count > valueLimit { node["valueTruncated"] = true }
        if let parent = parent { node["parent"] = parent }
        if !url.isEmpty { node["url"] = url }
        let identifier = string(element, kAXIdentifierAttribute)
        if !identifier.isEmpty { node["identifier"] = identifier }
        if let enabled = attribute(element, kAXEnabledAttribute) as? Bool { node["enabled"] = enabled }
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        node["settable"] = settable.boolValue
        if ["AXMenuItem", "AXPopUpButton"].contains(role) || (role == "AXGroup" && title.hasPrefix("Model:")) {
            var actions: CFArray?
            if AXUIElementCopyActionNames(element, &actions) == .success { node["actions"] = actions as? [String] ?? [] }
        }
        nodes.append(node); nextHandles[id] = element; nextLabels[id] = label(element)
        for child in children(element) { visit(child, id, depth + 1) }
    }
    visit(focusedWindow, nil, 0)
    let conversation = urls.first { value in
        guard let url = URL(string: value) else { return false }
        return url.scheme == "https" && url.host == "claude.ai" && (url.path.hasPrefix("/chat/") || url.path.hasPrefix("/project/") || url.path == "/new" || url.path == "/")
    } ?? ""
    if conversation.isEmpty { try fail("unsupported_view", "Open a Claude conversation or a new-task screen. Settings and authentication pages are not control targets.") }
    if retain { handles = nextHandles; handleLabels = nextLabels; snapshotContext = conversation; snapshotApp = key }
    return ["app": key, "bundleId": allowedApps[key]!, "conversation": conversation, "windowTitle": string(focusedWindow, kAXTitleAttribute), "nodes": nodes, "clipped": clipped, "foreground": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == app.bundleIdentifier]
}

func act(_ params: [String: Any]) throws -> [String: Any] {
    try requirePermission()
    if !bridgeControlEnabled { try fail("control_disabled", "Desktop control is disabled in Lounge.") }
    guard let key = params["app"] as? String, key == snapshotApp,
          let context = params["conversation"] as? String, context == snapshotContext,
          let id = params["nodeId"] as? String, let element = handles[id], let expectedLabel = handleLabels[id]
    else { try fail("stale_target", "Inspect the exact conversation before acting.") }
    let current = try inspect(key, retain: false)
    if current["foreground"] as? Bool == true { try fail("source_in_use", "Claude is in the foreground. Return to Lounge before controlling this conversation.") }
    if current["conversation"] as? String != context || label(element) != expectedLabel { try fail("stale_target", "The Claude view changed. No action was sent.") }
    if current["clipped"] as? Bool == true { try fail("incomplete_view", "The Claude view is too large to verify safely.") }
    for guardValue in params["guards"] as? [[String: String]] ?? [] {
        guard let guardId = guardValue["nodeId"], let guardElement = handles[guardId], let expected = guardValue["expectedValue"],
              string(guardElement, kAXValueAttribute) == expected else { try fail("draft_changed", "A guarded value changed. No action was sent.") }
    }
    let operation = params["operation"] as? String ?? ""
    let role = string(element, kAXRoleAttribute)
    let result: AXError
    if operation == "setValue" {
        guard ["AXTextArea", "AXTextField", "AXComboBox"].contains(role), let value = params["value"] as? String, value.count <= 100000,
              let expected = params["expectedValue"] as? String,
              string(element, kAXValueAttribute) == expected else { try fail("draft_changed", "The input changed. Its draft was preserved.") }
        result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    } else if operation == "press" {
        guard ["AXButton", "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXLink", "AXCheckBox"].contains(role) else { try fail("unsupported_control", "This element is not an actionable control.") }
        result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    } else if operation == "expandMenu" {
        guard role == "AXMenuItem", string(element, kAXTitleAttribute) == "More models" || string(element, kAXTitleAttribute).hasPrefix("Effort ") else { try fail("unsupported_control", "Only the source model's submenus support expansion.") }
        var parent = attribute(element, kAXParentAttribute) as! AXUIElement?
        var inModelMenu = false
        for _ in 0..<40 {
            guard let current = parent else { break }
            if string(current, kAXRoleAttribute) == "AXGroup" && string(current, kAXTitleAttribute).hasPrefix("Model:") { inModelMenu = true; break }
            parent = attribute(current, kAXParentAttribute) as! AXUIElement?
        }
        if !inModelMenu { try fail("unsupported_control", "The submenu is outside the source model control.") }
        if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success { try fail("action_unavailable", "The model submenu could not receive focus.") }
        if attribute(element, kAXExpandedAttribute) as? Bool == true {
            handles.removeAll(); handleLabels.removeAll(); snapshotContext = ""; snapshotApp = ""
            return ["accepted": true]
        }
        let app = try application(key), appElement = AXUIElementCreateApplication(app.processIdentifier)
        var exactFocus = false
        let focusDeadline = Date().addingTimeInterval(0.6)
        repeat {
            if attribute(element, kAXExpandedAttribute) as? Bool == true { handles.removeAll();handleLabels.removeAll();snapshotContext="";snapshotApp="";return ["accepted":true] }
            var focused = attribute(appElement, kAXFocusedUIElementAttribute) as! AXUIElement?
            for _ in 0..<12 { guard let current = focused else { break }; if CFEqual(current, element) { exactFocus = true; break }; focused = attribute(current, kAXParentAttribute) as! AXUIElement? }
            if exactFocus { break };Thread.sleep(forTimeInterval:0.02)
        } while Date() < focusDeadline
        if !exactFocus { try fail("action_unavailable", "The exact model submenu did not receive focus. No key was sent.") }
        let checked = try inspect(key, retain: false)
        if checked["conversation"] as? String != context || checked["foreground"] as? Bool == true || label(element) != expectedLabel { try fail("stale_target", "The source changed before opening its submenu.") }
        // A private-state Right-arrow goes only to this app's PID and a verified
        // model submenu. Never post text, Return or an OS-wide keyboard event.
        guard let eventSource = CGEventSource(stateID: .privateState), let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 124, keyDown: true), let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 124, keyDown: false) else { try fail("action_unavailable", "The app-scoped menu event was unavailable.") }
        down.flags = []; up.flags = []; down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
        result = .success
    } else if operation == "cancel" || operation == "showMenu" {
        let action = operation == "cancel" ? kAXCancelAction : kAXShowMenuAction
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let available = names as? [String], available.contains(action),
              (operation == "cancel" ? role == "AXGroup" && string(element, kAXTitleAttribute).hasPrefix("Model:") : ["AXMenuItem", "AXPopUpButton"].contains(role))
        else { try fail("unsupported_control", "This menu does not expose the requested accessibility action.") }
        result = AXUIElementPerformAction(element, action as CFString)
    } else { try fail("unsupported_operation", "Only scoped controls and guarded text input are supported.") }
    if result != .success { try fail("action_unavailable", "Claude did not accept the accessibility action. Nothing was retried.") }
    // Handles are single-use. A second action must start with a fresh inspection.
    handles.removeAll(); handleLabels.removeAll(); snapshotContext = ""; snapshotApp = ""
    return ["accepted": true]
}

// The native CLI requires a terminal even for its one-shot desktop opener.
// Give only that fixed command a private PTY; no shell or terminal recording.
func openClaudeCode(_ params: [String: Any]) throws -> [String: Any] {
    guard let id=params["sessionId"] as? String, UUID(uuidString:id) != nil,
          let binary=params["binary"] as? String,
          ["/opt/homebrew/bin/claude","/usr/local/bin/claude",NSHomeDirectory()+"/.local/bin/claude"].contains(binary),
          FileManager.default.isExecutableFile(atPath:binary),
          let cwd=params["cwd"] as? String,cwd.hasPrefix("/"),
          !["/","/Users","/System","/Library","/Applications","/private","/etc","/usr"].contains(cwd)
    else {try fail("invalid_handoff","Select a saved Claude Code session and a project workspace.")}
    var directory:ObjCBool=false
    guard FileManager.default.fileExists(atPath:cwd,isDirectory:&directory),directory.boolValue else{try fail("invalid_handoff","The project workspace is unavailable.")}
    var master:Int32 = -1,slave:Int32 = -1
    guard openpty(&master,&slave,nil,nil,nil)==0 else{try fail("handoff_unavailable","The native handoff terminal was unavailable.")}
    defer{Darwin.close(master);Darwin.close(slave)}
    let terminal=FileHandle(fileDescriptor:slave,closeOnDealloc:false),process=Process()
    process.executableURL=URL(fileURLWithPath:binary);process.arguments=["--desktop","--resume",id];process.currentDirectoryURL=URL(fileURLWithPath:cwd)
    var environment=ProcessInfo.processInfo.environment
    for key in Array(environment.keys) where key.hasPrefix("ANTHROPIC_") || key.hasPrefix("CLAUDE_CODE_USE_") || ["CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","ELEVENLABS_API_KEY","NODE_OPTIONS","NODE_PATH","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","DYLD_FRAMEWORK_PATH"].contains(key){environment.removeValue(forKey:key)}
    environment["CLAUDE_CODE_MAX_RETRIES"]="0";process.environment=environment
    process.standardInput=terminal;process.standardOutput=terminal;process.standardError=terminal
    let timeout=DispatchWorkItem{if process.isRunning{process.terminate()}}
    try process.run();DispatchQueue.global().asyncAfter(deadline:.now()+10,execute:timeout)
    // Read non-blockingly: the parent's slave handle stays open until cleanup.
    _=fcntl(master,F_SETFL,O_NONBLOCK)
    var output=Data(),buffer=[UInt8](repeating:0,count:4096)
    while process.isRunning {
        let count=Darwin.read(master,&buffer,buffer.count)
        if count>0{output.append(contentsOf:buffer.prefix(count))}
        if output.count>65536{process.terminate();break}
        usleep(10000)
    }
    process.waitUntilExit();timeout.cancel()
    while true{let count=Darwin.read(master,&buffer,buffer.count);if count<=0{break};if output.count<65536{output.append(contentsOf:buffer.prefix(count))}}
    return ["opened":process.terminationStatus==0 && String(data:output,encoding:.utf8)?.contains("Opening session \(id) in Claude Desktop")==true]
}

func dispatch(_ method: String, _ params: [String: Any]) throws -> [String: Any] {
    if method == "openClaudeCode" {return try openClaudeCode(params)}
    if method == "status" {
        return ["platform": "macos", "accessibility": permission(), "controlEnabled": bridgeControlEnabled, "capabilities": ["cancelModelMenu", "expandModelMenu"], "apps": allowedApps.map { key, bundle in ["id": key, "bundleId": bundle, "running": !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty] as [String: Any] }]
    }
    if method == "setEnabled" { bridgeControlEnabled = permission() && params["enabled"] as? Bool == true; if !bridgeControlEnabled { handles.removeAll();handleLabels.removeAll() };return ["enabled":bridgeControlEnabled] }
    if method == "requestPermission" {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return ["accessibility": AXIsProcessTrustedWithOptions(options)]
    }
    if method == "inspect" { return try inspect(params["app"] as? String ?? "") }
    if method == "act" { return try act(params) }
    if method == "reveal" {
        try requirePermission()
        if !bridgeControlEnabled { try fail("control_disabled", "Desktop control is disabled in Lounge.") }
        let key = params["app"] as? String ?? ""
        let current = try inspect(key)
        guard let expected = params["conversation"] as? String, current["conversation"] as? String == expected else { try fail("stale_target", "The Claude conversation changed before opening it.") }
        let app = try application(key)
        let activate = { app.activate(options: []) }
        let accepted = Thread.isMainThread ? activate() : DispatchQueue.main.sync(execute: activate)
        return ["accepted": accepted]
    }
    try fail("unsupported_method", "Unknown desktop operation.")
}

func bridgeReply(_ line: String) -> String {
    var reply: [String: Any] = [:]
    do {
        guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], let method = request["method"] as? String else { try fail("invalid_request", "Expected a JSON request.") }
        reply["id"] = request["id"] ?? NSNull()
        reply["result"] = try dispatch(method, request["params"] as? [String: Any] ?? [:])
    } catch let error as BridgeError { reply["error"] = ["code": error.code, "message": error.message] }
      catch { reply["error"] = ["code": "bridge_error", "message": "The desktop operation could not be completed."] }
    if let data = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { return text }
    return "{\"error\":{\"code\":\"serialization_error\",\"message\":\"The desktop response could not be encoded.\"}}"
}

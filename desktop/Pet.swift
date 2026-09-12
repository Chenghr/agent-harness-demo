import Cocoa
import WebKit

// The desktop shell has no filesystem, shell, or model bridge. The only bridge
// commands affect its own window; all task access stays in the local service.
final class PetWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
final class PetApp: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: PetWindow!
    var web: WKWebView!
    var menuItem: NSStatusItem!
    let baseURL: URL
    init(url: URL) { self.baseURL = url; super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "pet")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        window = PetWindow(contentRect: NSRect(x: 100,y:100,width:400,height:740),styleMask:[.borderless],backing:.buffered,defer:false)
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary]
        window.contentView = web
        if let frame = NSScreen.main?.visibleFrame { window.setFrameOrigin(NSPoint(x:frame.maxX-420,y:frame.minY+15)) }
        window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url:baseURL))
        menuItem = NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength)
        menuItem.button?.title = "小艺"
        let menu = NSMenu()
        menu.addItem(withTitle:"显示小艺",action:#selector(showPet),keyEquivalent:"").target = self
        menu.addItem(withTitle:"收起小艺",action:#selector(hidePet),keyEquivalent:"").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle:"退出小艺",action:#selector(quit),keyEquivalent:"q").target = self
        menuItem.menu = menu
        NSApp.activate(ignoringOtherApps:true)
    }
    @objc func showPet() { window.orderFrontRegardless() }
    @objc func hidePet() { window.orderOut(nil) }
    @objc func quit() { NSApp.terminate(nil) }
    func resize(mode: String) {
        let old = window.frame
        let size: NSSize
        switch mode {
        case "expanded": size = NSSize(width:400,height:740)
        case "peek": size = NSSize(width:380,height:300)
        default: size = NSSize(width:280,height:180)
        }
        let visible = window.screen?.visibleFrame ?? NSScreen.main!.visibleFrame
        let x = max(visible.minX,min(old.maxX-size.width,visible.maxX-size.width))
        let y = max(visible.minY,min(old.minY,visible.maxY-size.height))
        window.setFrame(NSRect(origin:NSPoint(x:x,y:y),size:size),display:true,animate:true)
    }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == baseURL.host,
              message.frameInfo.securityOrigin.port == baseURL.port,
              let action = message.body as? String else { return }
        switch action {
        case "expand": resize(mode:"expanded")
        case "peek": resize(mode:"peek")
        case "collapse": resize(mode:"collapsed")
        case "close": quit()
        case "open":
            var parts = URLComponents(url:baseURL,resolvingAgainstBaseURL:false)!
            parts.queryItems = parts.queryItems?.filter { $0.name != "native" }
            if let url = parts.url { NSWorkspace.shared.open(url) }
        case "drag": if let event = NSApp.currentEvent { window.performDrag(with:event) }
        default: break
        }
    }
    func webView(_ webView: WKWebView,decidePolicyFor navigationAction: WKNavigationAction,decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
        guard let url = navigationAction.request.url,
              url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port,
              ["/pet", "/pet/", "/pet.html"].contains(url.path) else { decisionHandler(.cancel);return }
        decisionHandler(.allow)
    }
    func applicationWillTerminate(_ notification: Notification) {
        // Closing a window cancels only its companion request, never the main task.
        web.stopLoading()
        web.configuration.userContentController.removeScriptMessageHandler(forName:"pet")
    }
}
let args = CommandLine.arguments
let address = args.count > 1 ? args[1] : "http://127.0.0.1:4317/pet/?native=1"
guard let url = URL(string:address),url.scheme == "http",["127.0.0.1","localhost"].contains(url.host ?? ""),["/pet", "/pet/"].contains(url.path) else {
    fputs("小艺只允许连接本机 /pet/ 页面。\n",stderr);exit(1)
}
let app = NSApplication.shared
let delegate = PetApp(url:url)
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

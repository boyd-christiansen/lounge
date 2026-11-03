import Foundation
@main struct BridgeCLI {
    static func main() {
        while let line = readLine() { print(bridgeReply(line)); fflush(stdout) }
    }
}

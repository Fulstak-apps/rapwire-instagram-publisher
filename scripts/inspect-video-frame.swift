import Foundation
import Vision
import ImageIO

// Local Apple Vision OCR/face geometry only. No network, model API or captions
// are generated here. Coordinates are normalized with a top-left origin.
struct Box: Codable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    init(_ r: CGRect) { x = r.minX; y = 1 - r.maxY; width = r.width; height = r.height }
}
struct TextItem: Codable { var text: String; var confidence: Float; var box: Box }
struct Observation: Codable { var text: [TextItem]; var faces: [Box] }
var output: [Observation] = []
for name in CommandLine.arguments.dropFirst() {
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: name), options: [:])
    let text = VNRecognizeTextRequest()
    text.recognitionLevel = .accurate
    text.usesLanguageCorrection = false
    let faces = VNDetectFaceRectanglesRequest()
    try handler.perform([text, faces])
    var lines: [TextItem] = []
    for item in text.results ?? [] {
        if let value = item.topCandidates(1).first {
            lines.append(TextItem(text: value.string, confidence: value.confidence, box: Box(item.boundingBox)))
        }
    }
    var faceBoxes: [Box] = []
    for item in faces.results ?? [] { faceBoxes.append(Box(item.boundingBox)) }
    output.append(Observation(text: lines, faces: faceBoxes))
}
let data = try JSONEncoder().encode(output)
FileHandle.standardOutput.write(data)

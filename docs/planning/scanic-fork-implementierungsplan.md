# Scanic Fork – Implementierungsplan

## Projektziel

Scanic so erweitern, dass Dokumente mit geringem Kontrast zum Hintergrund (z.B. weißes Papier auf hellem Holztisch) zuverlässig erkannt werden. Der kleine WASM-Footprint (~80–150 KB) soll erhalten bleiben.

---

## Problemanalyse (Zusammenfassung)

| Aspekt | Ist-Zustand | Problem |
|--------|-------------|---------|
| Papier-Helligkeit | ~203/255 | Kontrast zum Hintergrund nur ~20 Stufen |
| Hintergrund-Helligkeit | ~183/255 | Canny(75,200) erkennt diese Kante nicht |
| Canny-Schwellen | 75/200 (Standard) | Zu hoch für geringe Kontraste |
| Konturauswahl | Größte Kontur (blind) | Wählt Bildinhalt statt Dokumentrand |
| Preprocessing | Keines | Kein CLAHE, kein adaptives Thresholding |

**Kernproblem**: Scanic hat keinerlei Kontrastverbesserung vor der Kantenerkennung und validiert die gefundene Kontur nicht auf Form oder Größe.

---

## Architektur-Übersicht

### Aktuelle Pipeline (scanic v0.1.8)

```
ImageData → Grayscale (JS) → Gaussian Blur (WASM) → Sobel-Gradienten (WASM)
→ Non-Maximum Suppression (WASM) → Hysteresis Thresholding (WASM)
→ Dilation (WASM) → Konturfindung (JS) → Größte Kontur → Ecken (JS)
```

### Neue Pipeline (Ziel)

```
ImageData → Grayscale (JS) → CLAHE (WASM/Rust) → Adaptive Threshold (WASM/Rust)
→ Morphological Close (WASM/Rust) → Konturfindung (JS, bestehend)
→ Konturfilterung NEU (JS) → Ecken (JS, bestehend)
```

### Fallback-Strategie

```
1. Versuch: Neue Pipeline (CLAHE + Adaptive Threshold)
2. Fallback: Alte Pipeline (Canny) mit niedrigeren Schwellen (30/90)
3. Beide Ergebnisse: Beste Kontur nach Scoring auswählen
```

---

## Dateistruktur im Fork

```
scanic/
├── src/
│   ├── lib.rs              ← WASM-Einstiegspunkt (bestehend + erweitern)
│   ├── canny.rs            ← Bestehende Canny-Implementierung (beibehalten)
│   ├── clahe.rs            ← NEU: CLAHE-Algorithmus
│   ├── adaptive_thresh.rs  ← NEU: Adaptives Thresholding
│   ├── morphology.rs       ← NEU: Morphological Close (Erode + Dilate)
│   └── ...                 ← Bestehende Dateien (gaussian_blur, etc.)
├── js/
│   ├── scanic.js           ← Haupt-JS (detectDocument erweitern)
│   ├── preprocessing.js    ← NEU: JS-Wrapper für CLAHE/Threshold
│   └── contour_filter.js   ← NEU: Konturvalidierung
├── Cargo.toml
├── package.json
└── Dockerfile              ← Bestehender WASM-Build
```

---

## Phase 1: Rust/WASM – Neue Funktionen

### 1.1 CLAHE implementieren (`src/clahe.rs`)

**Algorithmus-Schritte:**

1. Bild in Tiles aufteilen (Standard: 8×8 Grid)
2. Pro Tile: Histogramm berechnen (256 Bins)
3. Clip Limit anwenden: Überschüssige Pixel gleichmäßig umverteilen
4. CDF (Cumulative Distribution Function) pro Tile berechnen
5. Für jedes Pixel: Bilineare Interpolation zwischen 4 benachbarten Tile-CDFs

**Rust-Signatur:**

```rust
#[wasm_bindgen]
pub fn clahe(
    input: &[u8],       // Grayscale-Bild (1 Byte pro Pixel)
    width: u32,
    height: u32,
    tile_grid_x: u32,   // Anzahl Tiles horizontal (Standard: 8)
    tile_grid_y: u32,   // Anzahl Tiles vertikal (Standard: 8)
    clip_limit: f32,     // Clipping-Schwelle (Standard: 2.0–4.0)
) -> Vec<u8>            // Kontrastverbessertes Grayscale-Bild
```

**Implementierungsdetails:**

- Tile-Größe = `(width / tile_grid_x, height / tile_grid_y)`
- Clip Limit wird auf Histogramm-Ebene angewandt: `clip_limit * (tile_pixels / 256)`
- Überschüssige Pixel werden gleichmäßig auf alle 256 Bins verteilt
- Bilineare Interpolation für sanfte Übergänge zwischen Tiles
- Randpixel: Nächste Tile-CDF verwenden (kein Wrap-Around)

**Geschätzte Code-Größe:** ~120 Zeilen Rust

**Erwartete WASM-Größe:** ~2–4 KB zusätzlich (nur Schleifen und Lookups, keine komplexen Abhängigkeiten)

### 1.2 Adaptives Thresholding (`src/adaptive_thresh.rs`)

**Algorithmus (Gaussian-Variante):**

1. Gaussian Blur auf Eingabebild anwenden (bereits in WASM vorhanden)
2. Pro Pixel: `output = (input[i] > blur[i] - C) ? 255 : 0`
3. C ist ein konstanter Offset (Standard: 10–15)

**Rust-Signatur:**

```rust
#[wasm_bindgen]
pub fn adaptive_threshold(
    input: &[u8],       // Grayscale nach CLAHE
    blurred: &[u8],     // Gaussian Blur des Inputs (separat berechnet)
    width: u32,
    height: u32,
    offset: i32,         // Konstante C (Standard: 12)
    invert: bool,        // true = Dokument wird weiß, Hintergrund schwarz
) -> Vec<u8>            // Binärbild (0 oder 255)
```

**Hinweis:** Der Gaussian Blur wird separat mit der bestehenden `blur()`-Funktion berechnet und dann übergeben. Dadurch kein doppelter Code.

**Alternative (falls bessere Ergebnisse):** Statt Gaussian auch Mean-basiertes adaptives Thresholding implementieren – einfacher und manchmal robuster für Dokumente. Nutzt ein Integral-Bild für O(1)-Berechnung pro Pixel.

**Geschätzte Code-Größe:** ~30 Zeilen Rust

### 1.3 Morphological Close (`src/morphology.rs`)

Scanic hat bereits `dilate()`. Es fehlt `erode()` für eine Close-Operation (Dilate → Erode), die Lücken in Dokumenträndern schließt.

**Rust-Signatur:**

```rust
#[wasm_bindgen]
pub fn erode(
    input: &[u8],
    width: u32,
    height: u32,
    kernel_size: u32,    // Standard: 5
) -> Vec<u8>

#[wasm_bindgen]
pub fn morphological_close(
    input: &[u8],
    width: u32,
    height: u32,
    kernel_size: u32,    // Standard: 5
    iterations: u32,     // Standard: 2
) -> Vec<u8>
// Intern: dilate → erode (jeweils iterations-mal)
```

**Geschätzte Code-Größe:** ~40 Zeilen Rust (Erode ist invertiertes Dilate)

### 1.4 WASM-Export in `lib.rs`

Bestehende Exports beibehalten und neue hinzufügen:

```rust
// Bestehend (nicht ändern):
pub fn canny_edge_detector_full(...)
pub fn blur(...)
pub fn dilate(...)
// ...

// Neu:
pub fn clahe(...)
pub fn adaptive_threshold(...)
pub fn erode(...)
pub fn morphological_close(...)
```

### 1.5 WASM-Build

```bash
# Bestehender Docker-Build (aus package.json):
npm run build:wasm

# Oder manuell:
wasm-pack build --target web --release
```

**Erwartete Gesamt-WASM-Größe:** ~100–130 KB (aktuell ~80 KB + ~30–50 KB neue Funktionen)

---

## Phase 2: JavaScript – Neue Pipeline

### 2.1 Preprocessing-Modul (`js/preprocessing.js`)

```javascript
// Pseudocode für die neue Preprocessing-Pipeline
export function preprocessForDocumentDetection(grayscale, width, height, wasmModule) {
    // 1. CLAHE anwenden
    const enhanced = wasmModule.clahe(grayscale, width, height, 8, 8, 3.0);

    // 2. Gaussian Blur (bestehende Funktion)
    const blurred = wasmModule.blur(enhanced, width, height, 21); // Großer Kernel (21x21)

    // 3. Adaptives Thresholding
    const binary = wasmModule.adaptive_threshold(enhanced, blurred, width, height, 12, true);

    // 4. Morphological Close (Lücken schließen)
    const closed = wasmModule.morphological_close(binary, width, height, 5, 2);

    return closed;
}
```

### 2.2 Konturfilterung (`js/contour_filter.js`)

**Aktuelles Problem (Zeile 1068 in scanic.js):**

```javascript
// ALT: Nimmt blind die größte Kontur
const documentContour = contours[0]; // ← Hier liegt das Problem
```

**Neue Filterlogik:**

```javascript
export function findDocumentContour(contours, imageWidth, imageHeight) {
    const imageArea = imageWidth * imageHeight;
    const minArea = imageArea * 0.15;  // Dokument muss min. 15% des Bildes sein
    const maxArea = imageArea * 0.98;  // Nicht das ganze Bild

    // Konturen filtern und scoren
    const candidates = contours
        .map(contour => {
            const area = contourArea(contour);
            const approx = approxPolyDP(contour, 0.02 * arcLength(contour));
            const corners = approx.length;
            return { contour, area, corners, approx };
        })
        .filter(c => {
            // Muss 4 Ecken haben (Rechteck/Trapez)
            if (c.corners !== 4) return false;
            // Muss sinnvolle Größe haben
            if (c.area < minArea || c.area > maxArea) return false;
            // Muss konvex sein
            if (!isConvex(c.approx)) return false;
            // Winkel müssen annähernd rechtwinklig sein (60°–120°)
            if (!hasReasonableAngles(c.approx, 60, 120)) return false;
            return true;
        })
        .sort((a, b) => b.area - a.area); // Größte zuerst

    return candidates.length > 0 ? candidates[0] : null;
}
```

**Hilfsfunktionen zu implementieren:**

- `isConvex(polygon)` – Prüft ob alle Kreuzprodukte gleiches Vorzeichen haben
- `hasReasonableAngles(polygon, min, max)` – Winkel zwischen Kanten berechnen
- `contourArea(contour)` – Shoelace-Formel (existiert vermutlich schon teilweise)

### 2.3 Hauptfunktion anpassen (`js/scanic.js`)

Die bestehende `detectDocumentInternal()`-Funktion erweitern:

```javascript
async function detectDocumentInternal(imageData, options = {}) {
    const { width, height } = imageData;
    const grayscale = convertToGrayscale(imageData);

    // ===== NEUE PIPELINE =====
    const preprocessed = preprocessForDocumentDetection(
        grayscale, width, height, wasmModule
    );

    // Konturen finden (bestehende Funktion)
    const contours = findContours(preprocessed, width, height);

    // NEU: Gefilterte Konturauswahl
    let document = findDocumentContour(contours, width, height);

    // ===== FALLBACK: Alte Canny-Pipeline =====
    if (!document) {
        // Canny mit niedrigeren Schwellen versuchen
        const edges = wasmModule.canny_edge_detector_full(
            grayscale, width, height,
            5,    // Blur Kernel
            30,   // Low Threshold (statt 75)
            90,   // High Threshold (statt 200)
            3,    // Dilation Kernel
            false // L2gradient
        );
        const cannyContours = findContours(edges, width, height);
        document = findDocumentContour(cannyContours, width, height);
    }

    if (!document) {
        return null; // Kein Dokument gefunden
    }

    // Ecken finden (bestehende Funktion)
    return findCornerPoints(document.approx);
}
```

---

## Phase 3: Parameter-Tuning

### 3.1 Empfohlene Standardwerte

| Parameter | Wert | Begründung |
|-----------|------|------------|
| CLAHE tile_grid | 8×8 | OpenCV-Standard, guter Kompromiss |
| CLAHE clip_limit | 3.0 | Getestet: Verstärkt Papier-Holz-Kontrast ausreichend |
| Blur Kernel (für Adaptive Thresh) | 21 | Groß genug um lokale Textur zu glätten |
| Adaptive Threshold Offset C | 12 | Getestet: Guter Wert für helle Oberflächen |
| Morph Close Kernel | 5×5 | Schließt 2–3px Lücken in Kanten |
| Morph Close Iterations | 2 | Doppelte Iteration für robustere Ränder |
| Min. Dokumentfläche | 15% des Bildes | Filtert kleine Artefakte aus |
| Winkeltoleranz | 60°–120° | Erlaubt perspektivische Verzerrung |

### 3.2 Parameter über Options-Objekt exponieren

```javascript
// API für Nutzer
scanic.detectDocument(imageData, {
    clahe: { tileGrid: [8, 8], clipLimit: 3.0 },
    threshold: { blockSize: 21, offset: 12 },
    morphology: { kernelSize: 5, iterations: 2 },
    contourFilter: { minAreaRatio: 0.15, angleRange: [60, 120] },
    fallbackCanny: { lowThreshold: 30, highThreshold: 90 },
    useFallback: true  // Canny-Fallback aktivieren
});
```

---

## Phase 4: Tests

### 4.1 Testbilder erstellen/sammeln

| Szenario | Beschreibung | Erwartung |
|----------|-------------|-----------|
| **low-contrast** | Weißes Papier auf hellem Holztisch | ✓ Erkennung |
| **high-contrast** | Weißes Papier auf dunklem Tisch | ✓ Erkennung (Regression?) |
| **angled** | Papier schräg fotografiert | ✓ Erkennung mit 4 Ecken |
| **partial** | Papier ragt über Bildrand hinaus | ✗ Keine falsche Erkennung |
| **no-document** | Nur Tisch, kein Papier | ✗ null zurückgeben |
| **multi-document** | Zwei Papiere | ✓ Größtes Dokument erkennen |
| **textured-bg** | Papier auf gemusterter Oberfläche | ✓ Erkennung |
| **colored-paper** | Gelbes/blaues Papier | ✓ Erkennung |

### 4.2 Automatisierte Tests

```javascript
// test/detection.test.js
describe('Document Detection', () => {
    test('detects white paper on light wood', async () => {
        const result = await scanic.detectDocument(lowContrastImage);
        expect(result).not.toBeNull();
        expect(result.corners).toHaveLength(4);
    });

    test('returns null when no document present', async () => {
        const result = await scanic.detectDocument(noDocumentImage);
        expect(result).toBeNull();
    });

    test('does not regress on high-contrast images', async () => {
        const result = await scanic.detectDocument(highContrastImage);
        expect(result).not.toBeNull();
        // Ecken-Genauigkeit prüfen
        expect(cornerDistance(result.corners, expectedCorners)).toBeLessThan(10);
    });
});
```

---

## Phase 5: Build und Release

### 5.1 Build-Reihenfolge

```bash
# 1. Rust/WASM kompilieren
npm run build:wasm
# Oder mit Docker:
docker run --rm -v $(pwd):/src rustlang/rust:nightly \
    wasm-pack build --target web --release

# 2. JS bundlen
npm run build

# 3. Tests laufen lassen
npm test

# 4. Package-Größe prüfen
ls -lh dist/scanic.js dist/*.wasm
# Ziel: < 150 KB gesamt
```

### 5.2 Package.json anpassen

```json
{
  "name": "@bbs-buchholz/scanic",
  "version": "0.2.0",
  "description": "Document edge detection with CLAHE preprocessing (fork of scanic)"
}
```

---

## Zeitschätzung

| Phase | Aufgabe | Aufwand |
|-------|---------|--------|
| 1.1 | CLAHE in Rust | 3–4 Stunden |
| 1.2 | Adaptive Threshold in Rust | 1 Stunde |
| 1.3 | Morphological Close in Rust | 1 Stunde |
| 1.4–1.5 | WASM-Export + Build | 1 Stunde |
| 2.1 | Preprocessing JS-Wrapper | 1 Stunde |
| 2.2 | Konturfilterung JS | 2–3 Stunden |
| 2.3 | Pipeline-Integration | 2 Stunden |
| 3 | Parameter-Tuning | 2–3 Stunden |
| 4 | Tests | 2–3 Stunden |
| 5 | Build + Release | 1 Stunde |
| | **Gesamt** | **~16–20 Stunden** |

---

## Risiken und Alternativen

### Risiko: CLAHE allein reicht nicht

**Mitigation:** Zusätzlich einen einfachen globalen Threshold als dritte Strategie einbauen. Unsere Tests zeigten, dass `threshold(195)` + Morphologie bei Weiß-auf-Hell perfekt funktioniert. Als dritter Fallback:

```
1. CLAHE + Adaptive Threshold → Konturen filtern
2. Canny(30, 90) → Konturen filtern
3. Global Threshold(195) + Morph Close → Konturen filtern
→ Beste Kontur nach Score auswählen
```

### Risiko: WASM-Build-Probleme

**Mitigation:** Phase 2 (JS-Konturfilterung) kann unabhängig von Phase 1 umgesetzt werden. Als Zwischenlösung kann CLAHE auch in reinem JS implementiert werden (~200 Zeilen, ~10–20ms für 800×450px). Die WASM-Version ist dann eine Performance-Optimierung.

### Risiko: Regression bei High-Contrast-Bildern

**Mitigation:** Fallback-Strategie mit bestehender Canny-Pipeline. Neue Pipeline wird nur bevorzugt, wenn sie ein besseres Ergebnis liefert (4-Ecken-Kontur mit größerer Fläche).

---

## Referenzen

- Scanic Original: https://github.com/marquaye/scanic
- CLAHE-Algorithmus: Zuiderveld (1994), "Contrast Limited Adaptive Histogram Equalization"
- OpenCV CLAHE-Referenzimplementierung: `cv::createCLAHE(clipLimit, tileGridSize)`
- Adaptives Thresholding: Sauvola & Pietikäinen (2000)
- Getestete Parameterwerte basieren auf Analyse vom 16.02.2026 (Claude-Session)

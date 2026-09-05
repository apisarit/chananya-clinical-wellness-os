# U Synthesise — Classical Luopan atlas

Added in U Synthesise 0.2.0; atlas data version 1.0.0 (2026-09-05).

This extends the existing authenticated `/luopan.html` spatial mode. The original birth-time wheel and its 113 TTM rules are preserved. The atlas is a traditional knowledge reference with named methods, not an automated fortune, building-safety, or medical assessment.

## Delivered surface

Five viewing presets: core, San He, San Yuan, Jin Suo Yu Guan, and all layers. The original full view contained 13 data rings plus a degree scale. Version 0.3.0 adds two Jin Suo Yu Guan study rings: **16 layers** total. A phone can show the complete overview, zoom to 150–300%, pan, and read a selected layer in ordinary-size text. The detailed readout includes every layer even when a viewing preset hides some rings.

| Ring | Coordinates / method |
|---|---|
| Degree scale | North 0°, clockwise, one-degree ticks |
| Eight directions | Eight 45° sectors |
| Later Heaven trigrams | Kan N, Gen NE, Zhen E, Xun SE, Li S, Kun SW, Dui W, Qian NW |
| Earlier Heaven trigrams | Kun N, Zhen NE, Li E, Dui SE, Qian S, Xun SW, Kan W, Gen NW |
| Lo Shu | Eight palace numbers; 5 belongs to the center |
| Palace elements | Later Heaven palace elements, 45° each |
| Earth Plate | Original fixed 24 Mountains, 15° each |
| Human Plate | Same mountain labels, centers and boundaries shifted −7.5° |
| Heaven Plate | Same mountain labels, centers and boundaries shifted +7.5° |
| Zheng Wu Xing | Element of each branch, stem, or corner trigram |
| Three Yuan dragons | Earth / Heaven / Human groups within each palace |
| San Yuan mountain polarity | Explicit mountain polarity; independent of natal stem / branch polarity |
| Heaven Plate double mountains | Twelve adjacent pairs, 30° each, with San He group elements |
| Twelve life stages | User-selected water-method element and yin / yang sequence |

The degree offsets are plate conventions, not magnetic declination corrections. All numeric ranges are half-open `[start,end)`, wrapping through north where needed. A supplied uncertainty interval touching a boundary includes both neighboring sectors conservatively. Unknown uncertainty remains unknown.

The Earth Plate facing/sitting axis is separated by 180°. The UI reports distance from the mountain center and nearest boundary without inventing a universal auspiciousness threshold. Clicking a ring or using the slider produces a clearly marked study position and clears any prior measurement uncertainty. Submitting the bearing form marks the reading as manually entered.

## Study catalogs

- All 24 mountains: Chinese, Thai pronunciation, pinyin, code, type, zodiac animal when applicable, exact range and center, own element, palace element, Yuan group, named San Yuan polarity, natal polarity when applicable, and opposite mountain. Search supports Thai, Chinese, unaccented pinyin, direction, or element.
- Eight trigrams: line diagrams, Thai names, natural/family correspondences, Earlier Heaven number and bearing, Later Heaven bearing and Lo Shu number.
- He Tu pairs and north-up Lo Shu square. Rotating a conventional south-up printed diagram by 180° preserves its geographical assignments and sums.
- All 64 hexagrams in a lower-trigram × upper-trigram matrix, with selectable trigrams and six-line graphics. Version 0.3.1 adds a short Thai meaning and reflection for each selected hexagram, originally worded from the public-domain *Zhouyi · Tuan* text, with a source link. **No compass bearing is assigned to this catalog.** A directional Da Gua ring needs a separately specified sequence and angular origin.
- Ten short guides covering measurement, facing/sitting, plate conventions, element systems, life stages, Flying Star prerequisites, fine divisions, and birth-symbol correspondence.

The descriptions distinguish San He and San Yuan. Fine rings (60, 72, 120, 240), directional 64 / 384 subdivisions, Flying Star natal charts, favorable directions, and automatic sensor readings are not implemented by this atlas. The page explains their prerequisites instead of synthesizing unsourced assignments.

## Sources and interpretation

Sources are attached to individual layers and exposed as links in the UI. Traditional correspondences are presented as traditional knowledge. The short Thai explanations and glossary are original editorial summaries; no long modern-source passages are reproduced.

- [Feng Shui Natural: compass, 24 Mountains, facing and sitting](https://www.fengshuinatural.com/en/fengshuicompass.htm)
- [Evelyn Escarfullery / FORMOSA Art: three plates and Luopan schools](https://www.formosa-art.com/feng-shui-knowledge/feng-shui-blog/evelyn-escarfullery/)
- [Classical Shuogua text](https://www.chineseclassic.com/content/196)
- [Shao Yong Earlier Heaven diagrams](https://www.eee-learning.com/article/5480)
- [Classical He Tu / Lo Shu discussion](https://www.eee-learning.com/book/6256)
- [Liu Xiejun: Three Yuan dragons and mountain yin/yang](https://www.cafengshuinet.com/m/show_detail.php?id=2781)
- [Liu Qizhi / Juxian Guan: double mountains and life-stage sequences](https://www.juxian.com.hk/fs005/)
- [Upper/lower trigram lookup for the 64 hexagrams](https://www.eee-learning.com/content/4)
- [周易 · 彖傳 — primary classical text for the concise Thai interpretations](https://zh.wikisource.org/wiki/周易/彖)
- [Hong Kong Observatory: stems and branches](https://www.hko.gov.hk/en/gts/time/stemsandbranches.htm)

Implementation scope for water methods is the pair table and named yin/yang sequences only. No incoming/outgoing-water judgment is inferred, and divergent or inconsistent prose examples in modern references are not incorporated as rules.

## Code and verification

`knowledge/u-synthesise/classical.mjs` is the source of data and lookups. `scripts/build-u-synthesise.mjs` generates `u-synthesise-classical.js`. `u-synthesise-luopan.js` renders the atlas and is imported by the existing `u-synthesise.js` entry point.

`npm run check:luopan` covers the existing authenticated/birth-time contracts plus independent fixtures for three-plate boundaries, all 24 mountain polarities, all eight life-stage tables, complete nonoverlapping circles, uncertainty, He Tu / Lo Shu, all 64 distinct six-line figures, search, zoom, mobile-coordinate tapping, input provenance and invalid-input clearing.

SVG views are rendered from the actual UI implementation for visual inspection. The browser session requires login, so authenticated device-level UI testing is not represented as completed by an offline renderer. Production verification additionally reads the actual page and imported scripts and checks the deployed source manifest against the merged commit.


## Jin Suo Yu Guan extension

U Synthesise 0.3.0 adds an explicitly scoped eight-palace landscape baseline; see [U_SYNTHESISE_LANDSCAPE.md](U_SYNTHESISE_LANDSCAPE.md). The prior atlas, three-plate and time calculations remain available.

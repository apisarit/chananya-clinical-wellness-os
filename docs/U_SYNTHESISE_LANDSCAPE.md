# U Synthesise 0.3.0 — Jin Suo Yu Guan landscape study

The user requested trying the landscape/water layer pictured on a 金锁玉关 reference ruler inside the existing U Synthesise application. This release adds two rings to the authenticated spatial view, taking the full atlas from 14 to 16 layers. The existing 23 time layers, April-start calendar, shared ray, birth calculations and all 113 legacy TTM rows remain intact.

## Included behavior

- A dedicated Jin Suo Yu Guan preset displays directions, Later Heaven trigrams, Lo Shu, Earth Plate, `พบ砂`, and `พบ水` together.
- The compass remains north-up and fixed. The two new rings use the eight Later Heaven palaces, not the shifted Human or Heaven plates.
- Lo Shu 1/N, 2/SW, 3/E, 4/SE prefer sha; 6/NW, 7/W, 8/NE, 9/S prefer shui in this explicitly named baseline. These are palace numbers, not annual Flying Stars.
- A 24-row lookup repeats the inherited palace baseline for each mountain. It does not claim 48 independent mountain-specific rules or reproduce the full classical verses.
- The reader accepts sha, shui, mixed and unclassified observations, plus an explicitly entered form condition. The display distinguishes the directional baseline from form review and incomplete data.
- Uncertainty spanning palaces that give different baselines produces an ambiguous result with both possibilities. Shared baselines still retain the uncertain palace list. An omitted uncertainty remains unknown.
- Up to 20 observations can be entered with their own bearing, uncertainty, name and notes, marked on the wheel and removed individually. These are session-memory observations, cleared on reload; they are not persisted or sent to a server.
- Copying a study ray retains its study provenance. Changing a feature's bearing clears the copied uncertainty. Birth changes never rewrite landscape observations, and an invalid current bearing clears the current result without deleting recorded observations.
- The outer authenticated page links to the existing standalone CHANANYA Wuxing/BaZi application and the CNYOS foundation page. Navigation transfers no birth, landscape or patient data. Existing destination permissions continue to apply.

## Source and interpretation scope

[靈寶樓 · 風水朴真 三](https://lingbaolou.net/风水朴真-三、-2/1068/) describes the basic eight-palace rule and the need to qualify a directional reading by observed form. Its text also discusses proposed Qi variants; those variants are not incorporated here. The attached reference image identifies the school, but is not used to invent unreadable fine-print judgments.

The Thai UI is an original short study summary. Sha/shui classifications are entered by the user, with an explicit unknown option. No automatic feature classification, weights, overall good/bad score, site alteration instructions, fortune prediction or health inference are produced. Mountain-specific verses, distance/size weighting, opposite-palace effects, full shape taxonomies, San He water techniques and Flying Star building charts require separate implementations and sources.

This source/UI addition does not establish commercial or clinical readiness of the OS. No database schema, clinical inference gate, release gate, authentication flow, patient record, tenant identity or backend function is changed.

## Implementation and verification

`knowledge/u-synthesise/landscape.mjs` is the rule source; the existing build generates `u-synthesise-landscape.js`. The atlas imports its two ring definitions. `u-synthesise-landscape-ui.js` adds the reader and observation list without network calls or browser storage.

`npm run check:luopan` tests all 48 mountain/type combinations against independent directional fixtures, palace boundaries and wraparound, conflicting uncertainty, form qualifications, mixed/unknown data, safe text insertion, observation provenance and persistence within the page. Existing birth/Kala/frame/atlas tests remain part of the same command. DOM-harness results are not represented as authenticated mobile-browser testing.

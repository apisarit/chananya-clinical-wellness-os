# Luopan 360° v1.0.0

This release packages the earlier full 23-layer birthday/time reading wheel for CNYOS. The later experimental house-rotation demonstration is not included.

## Routes and behavior

- `/luopan.html` (also `/luopan`) is a standalone, public knowledge tool. The TTM Foundation page links to it.
- The annual wheel begins on 1 April and uses actual calendar-day spans.
- Birth input accepts Buddhist or Gregorian years and `HH.mm` or `HH:mm` time. Example: `29/10/2530 22.19`.
- The central Kala cycle is 12 hours repeated twice: Pitta 10:00–14:00 / 22:00–02:00; Vata 14:00–18:00 / 02:00–06:00; Semha 06:00–10:00 / 18:00–22:00. Intervals include their start and exclude their end.
- Dragging the common reading ray explores the aligned scales without changing the entered birth data. It does not calculate transits.
- Houses remain explicitly reference houses until birthplace coordinates are entered. Bangkok is an explicitly labeled example button.
- The comparison includes Thai astrology, Thai lunar/seasonal context, Kala, BaZi pillars, stems, branches, hidden stems, Ten Gods and Wuxing generation/control relationships.
- Entered data stays in page memory. No database, authentication, analytics, browser storage or clinical-record writes are added.

## Knowledge boundaries retained

The shared ray is a display alignment, not evidence that compass bearings, celestial longitude, calendar fractions and traditional elements are equivalent. Calculated positions use Astronomy Engine 2.1.19 with an approximate Lahiri offset and whole-sign houses, not a Suriya Yat ephemeris. Kala detail and seasonal tables retain their review/source labels. Intercalary month 8 and the earlier Saha–Ari master rules remain explicitly unresolved. This tool does not issue diagnoses or prescriptions.

## Provenance and packaging

- Original conversation snapshot: `luopan-birthdate-ray.html`, before `luopan-house-rotation.html`.
- Original fragment SHA-256: `5ec6c41f467869a980d2c8d7145207d83df9a3cfd2a2266ab1a1668a1d3c32d2`.
- `luopan-knowledge.js`: original reference tables, 20 base layers and precomputed Thai lunar calendar records; the controller projects 23 displayed layers.
- Thai calendar records: CsDate from [pythaidate 0.2.0](https://github.com/hmmbug/pythaidate), 1899–2101 for calendar lookup; accepted input is 1900–2100 CE.
- `luopan-astronomy.js`: vendored [Astronomy Engine 2.1.19](https://github.com/cosinekitty/astronomy), with its MIT notice preserved; a copy is in `docs/licenses/ASTRONOMY_ENGINE_LICENSE.txt`.
- BaZi sample and boundary cases were independently compared with [lunar-javascript 1.7.7](https://github.com/6tail/lunar-javascript) during prototype verification. That library is not loaded by the production page.
- Expected sample pillars: `丁卯 庚戌 辛亥 己亥`; sample Kala: Pitta; Thai lunar date: waxing day 8, month 12.
- Inline scripts and inline data have been moved to same-origin files to work with CNYOS's existing Content Security Policy. The policy is unchanged. All essential sector data remains available in the live readout; SVG native titles provide supplementary hover labels.

## Validation and release

`node tests/luopan-birthdate.mjs` checks standalone script loading, 23-layer coverage, input/date boundaries, the sample pillars, drag/reset, reference-versus-calculated houses, and Kala transitions. The existing browser-security and publish-surface contracts cover the new page and assets.

The CNYOS production promotion and exact-commit external attestation requirements remain unchanged. Adding this route does not assert commercial production readiness, approve other changes or enable real-patient-data admission. Publish through the existing protected release workflow only after the exact candidate satisfies its release requirements.

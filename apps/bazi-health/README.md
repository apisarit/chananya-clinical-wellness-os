# CHANANYA Wuxing / BaZi + Health Assessment

Standalone public application for the existing `chananya-bazi-clinical.netlify.app` site. It is versioned in `apps/bazi-health` with its own static publish directory and checks. Deploy only this directory to Netlify project `536766a1-867e-4799-907c-08e3824a7b1c`.

## Recovered version

Based on `chananya-bazi-clinical-v1.6-relations-thai.html`, recovered from the original 18 August 2026 file. Its original SHA-256 is recorded in `provenance.json`. The source file's internal badge still said v1.3; the recovered filename and implemented Thai health/relations features identify it as v1.6. This reviewed release is v1.6.1.

The two tabs are **Wuxing / BaZi** and **Health Assessment**, sharing one birth form and one calculation. The release retains Four Pillars, hidden stems, Ten Gods, seasonal element weights, Day Master strength, structure, useful-element lenses, luck periods, annual interactions, stem/branch harmony, clashes, three-member groups, and Thai explanations. Both tabs work without requests, accounts, browser storage, analytics, or server functions. The health tab retains the original five-element organ associations and model-weight explanation. These are traditional interpretations, not clinical measurements, diagnosis, disease-risk scores, or treatment recommendations.

## Corrections

- January births before the minor-cold solar term now retain the previous solar year, fixing the year/month pillars.
- Late Zi-hour stems at 23:00 use the next day while the day pillar retains the midnight-rollover convention. This follows the reference library's default sect-2 convention.
- UTC+0 is preserved when calculating approximate luck-start time; fractional offsets are converted correctly.
- Invalid calendar dates and incomplete times are rejected. Month/year changes constrain the day selector. Invalid inputs hide stale results.
- Birth years show both Buddhist and Gregorian labels. Annual selections advance with the calendar.
- The old child-example copy is replaced by a fictional 15 January 2000 example.
- Scripts and styles are local assets; the CSP blocks network connections and inline scripts. Keyboard arrow/Home/End controls and ARIA states support the two tabs.

The compact solar-longitude calculation and season-weighted strength/useful-element heuristics remain from v1.6. Solar-term boundary instants and luck-start ages are approximate. Births within 0.12 degrees of a monthly solar-term boundary receive the original warning. Inputs use a selected fixed UTC offset; historical DST and apparent solar time are not inferred from a birthplace.

## Validation and sources

```sh
node apps/bazi-health/tests/contracts.mjs
node apps/bazi-health/scripts/build.mjs
```

The contract runs the real browser script against a DOM harness and checks 88 independently generated Four-Pillars vectors from [lunar-javascript 1.7.7](https://github.com/6tail/lunar-javascript), including January, Li Chun, leap-day, UTC-offset and late-Zi examples. The reference package is used to produce fixtures and is not a runtime dependency. Tab state, date constraints, shared results, invalid-input handling, relation groups and the five-element health model are also checked. This does not validate the traditional model as a clinical assessment.

The [Hong Kong Observatory's stem/branch reference](https://www.hko.gov.hk/en/gts/time/stemsandbranches.htm) describes the sexagenary cycle and hour-stem table. For the distinction between traditional practices and evidence about health effects, see [NCCIH's overview of traditional Chinese medicine](https://www.nccih.nih.gov/health/traditional-chinese-medicine-what-you-need-to-know).

## Production packaging

Commit the app before building. The build copies exactly four allowed assets into `dist/` and writes `release.json` with the commit, tree and SHA-256 of each asset. For Netlify's source-ZIP upload, copy this app to an isolated directory and supply `release-source.json` containing the built manifest's `source` object. The remote build verifies those hashes before publishing `dist/`. Source, fixtures and packaging files are excluded from the published directory.

The deployment is a separate static BaZi application. Its release does not change the CNYOS clinic site, data admission, database migrations or clinical-production approval requirements.

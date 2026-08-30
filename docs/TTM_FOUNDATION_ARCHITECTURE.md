# Chananya Thai Medicine Foundation

## Why this exists

The Clinical OS must not reduce Thai Traditional Medicine to a handful of form fields. Patient records consume a reviewed knowledge foundation; they do not own or replace that foundation.

The canonical direction is:

`Canon / Dataset → Concept → Relation → Encounter Evidence → Practitioner Confirmation`

This keeps provenance, meaning, patient-specific assertions, and professional accountability separate.

## Five layers

| Layer | Scope | Examples |
| --- | --- | --- |
| 1 | Cosmology and human model | Four elements, birth constitution, current constitution |
| 2 | Functional diagnosis | Samutthan, Pitta/Vata/Semha, coordinates, กำเริบ/หย่อน/พิการ, organs |
| 3 | Disease and specialty canon | Thai disease, symptom, mechanism, canon, specialty texts |
| 4 | Therapeutics and pharmacy knowledge | Treatment principles, formulas, herbs, tastes, cautions |
| 5 | Physical medicine | Procedures, Sen Prathan Sip, points, body map bindings |

Thai medicine is the primary ontology. ICD/WHO is a secondary mapping layer that must not overwrite the Thai diagnosis. AI is downstream of Clinical Core, Pharmacy, Production, Billing, Audit/Security, and QA, and may not replace practitioner judgment.

## Data boundaries

### `ttm_sources`

Registry of the canon, official document, owner dataset, clinical form, edition, and citation used by a statement. A source being registered does not mean all claims derived from it are approved.

### `ttm_concepts` and `ttm_concept_terms`

Stable identifiers for Thai medicine concepts and their preferred terms, synonyms, historical spellings, and transliterations. Each concept belongs to exactly one foundation layer for navigation, while relations provide the clinical meaning.

### `ttm_concept_relations`

Source-backed edges such as `coordinate_of`, `associated_element`, or `distinct_from`. Every edge has its own evidence note, review status, and version. A relation defaults to `review_required`.

### `ttm_encounter_concepts`

Patient-specific use of a foundation concept. It records the usage role, assertion status, evidence note, and explicit practitioner confirmation. It does not replace the structured diagnosis, examination, treatment, prescription, or sign-off records.

## Migration and fallback

`supabase/migrations/202608270100_ttm_foundation_ontology.sql` is additive and preserves all current data. It also imports the existing flat `ttm_diagnostic_knowledge` rows as legacy concepts so they remain visible during curation.

If the migration is not installed, `foundation.js` falls back read-only to `ttm_diagnostic_knowledge` and `sen_line_master`. The UI labels this state `Legacy bridge`; it must not imply that the full ontology is complete.

## Owner workbook import: พิกัดยา

The immutable dataset `data/ttm/pikad-ya-20260830.json.gz` preserves the owner-supplied workbook with SHA-256 `d5832b06110a5827e26ef28eec19f153c25256adde2bf11c4e6edc8a1fd77d5f`. Its companion manifest records nine worksheets, 565 normalized concepts, 1,548 source-backed relations and 13 cells that require specific numeric review.

The staging-only importer `scripts/import-pikad-staging.mjs` is fail-closed. It runs only when `CLINICAL_OS_STAGING_KNOWLEDGE_IMPORT=PIKAD-YA-20260830-v1`, the dedicated staging database is explicitly enabled and acknowledged, the runtime database matches the staging tenant config, and the Production Supabase origin is present as a denylist and differs from the target. It uses immutable versioned identifiers and ignores existing rows so a rerun cannot downgrade a curator's later approval.

All imported concepts and relations start as `review_required`. The original worksheet and cell references remain in metadata/qualifiers. Values without a stated unit remain `unit_status=not_specified`; eleven Excel date serials that display as `1/2` or `1/4` are stored as ambiguous source evidence, not converted to doses. ICD/WHO mapping is deliberately excluded from this import.

## Coverage debt that remains visible

- Canon registry with edition and page/verse-level citations.
- Pitta 42, Vata 80, and Semha 20 disease/symptom sets.
- Rupa-dhatu 42 and Thai medicine organ model.
- Formula, ingredient, amount, unit, taste, indication, contraindication, and revision links.
- Named Sen Prathan Sip, treatment points, procedure indications, contraindications, and outcomes.
- Practitioner review workflow for every `review_required` concept and relation.

Placeholder counts are not clinical completion. Release readiness requires reviewed content, traceable sources, safe encounter bindings, and QA.
